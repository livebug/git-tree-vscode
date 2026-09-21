/**
 * 单文件历史 → 版本树数据。
 *
 * 移植自 git-tree/backend/layout.py 的 `build_file_graph`。产出的 JSON 形状由
 * CONTRACT.md 冻结——渲染器直接读那些键，少一个就是空白。
 *
 * 这一层回答两个问题：
 *
 * 1. **谁改过这个文件**（`role: "author"`）——提交被归给"第一父链上包含它、
 *    且最具体"的那条分支。只通过合并进来的改动算继承，不算作者。
 * 2. **改动怎么往上走的**（`edges`）——一个合并把改动带进某条分支，当且仅当该
 *    改动能从它的某个**非第一父**到达，但**不能**从第一父到达。只看目标分支
 *    主线上的合并，箭头才有意义；最早那个这样的合并才是真正落地点。
 */

import { CommitStore } from './gitstore';
import { LaneInfo, laneColor, laneContaining, resolveLineage, statusText } from './lineage';
import { ChangeInfo, FileRecord, RepoHandle } from './repo';

// ---------------------------------------------------------------------------
// 产出类型（见 CONTRACT.md）
// ---------------------------------------------------------------------------

export interface VersionPayload {
  n: number;
  sha: string;
  short: string;
  ts: number;
  subject: string;
  author: string;
  status: string;
  labels: string[];
  x: number;
}

export interface TargetVersion {
  lane: number;
  sha: string;
  short: string;
  n: number;
  ts: number;
}

export interface EdgePayload {
  kind: 'merge' | 'fork';
  fromLane: number;
  toLane: number;
  sha: string;
  short: string;
  subject: string;
  author: string;
  x1: number;
  x2: number;
  targetVersion: TargetVersion | null;
}

export interface NodePayload {
  lane: number;
  sha: string;
  short: string;
  ts: number;
  author: string;
  subject: string;
  kind: 'commit';
  status: string;
  x: number;
  labels: string[];
}

export interface LanePayload {
  name: string;
  lane: number;
  kind: 'fixed' | 'other';
  color: string;
  remote: boolean;
  role: 'author' | 'carrier';
  versions: VersionPayload[];
  tip: string | null;
  tipShort: string | null;
  tipTs: number;
  tipSubject: string;
  tipAuthor: string;
  startTs: number;
  ownCount: number;
  reachCount: number;
  forkShort: string | null;
  forkTs: number | null;
  parentName: string | null;
  mergedInto: unknown[];
  incoming: unknown[];
  merged: boolean;
  nodeCount: number;
  x1: number;
  x2: number;
  forkX: number | null;
}

export interface CommitRowPayload {
  sha: string;
  short: string;
  ts: number;
  author: string;
  subject: string;
  parents: string[];
  changes: ChangeInfo[];
  status: string;
  labels: string[];
  containing: string[];
  origin: string | null;
  promotion: unknown[];
}

export interface FileGraphPayload {
  path: string;
  follow: boolean;
  lanes: LanePayload[];
  nodes: NodePayload[];
  edges: EdgePayload[];
  commits: CommitRowPayload[];
  range: { minTs: number; maxTs: number };
  warnings: string[];
  stats: Record<string, number>;
}

export interface FileGraphOptions {
  includeRemotes?: boolean;
  follow?: boolean;
  maxCommits?: number;
}

/** 沿时间向上找落地点时最多扫多少个合并——防止病态仓库上退化成 O(n²)。 */
const MAX_SCAN = 300;

/**
 * 建轨道并算好谱系。
 *
 * 固定分支排在前（**顺序就是用户给的发布层级**），其余按 refs 的顺序跟在后面；
 * 每个轨道拿到自己的 `reach`，最后跑 `resolveLineage` 填出 `own` / `fork` / `parentName`。
 *
 * 单独导出是为了让谱系规则可以被独立断言（见 test/rules.test.ts）——
 * 不把它藏进 buildFileGraph 里，测试就不必为了验证归属而伪造一份文件历史。
 */
export function buildLanes(
  repo: RepoHandle,
  fixedNames: readonly string[],
  includeRemotes = false,
): LaneInfo[] {
  const store = repo.store();
  const refs = repo.refs();
  const byName = new Map(refs.map((r) => [r.name, r]));

  const allLanes: LaneInfo[] = [];
  const taken = new Set<string>();

  for (const name of fixedNames) {
    const ref = byName.get(name);
    if (!ref || taken.has(name)) continue;
    // 注意：先占位再看 tip —— 名字重复或指向未知提交时，它也不该掉到"其他分支"里去
    taken.add(name);
    const tip = store.get(ref.sha);
    if (tip === undefined) continue;
    const lane = new LaneInfo(name, 'fixed');
    lane.tip = tip;
    lane.tipTs = store.ts[tip];
    lane.remote = ref.remote;
    allLanes.push(lane);
  }

  for (const ref of refs) {
    if (taken.has(ref.name)) continue;
    if (ref.remote && !includeRemotes) continue;
    const tip = store.get(ref.sha);
    if (tip === undefined) continue;
    const lane = new LaneInfo(ref.name, 'other');
    lane.tip = tip;
    lane.tipTs = store.ts[tip];
    lane.remote = ref.remote;
    allLanes.push(lane);
    taken.add(ref.name);
  }

  allLanes.forEach((lane, i) => {
    lane.lane = i;
    lane.reach = repo.reachForTip(lane.tip as number);
  });

  resolveLineage(allLanes, store);
  return allLanes;
}

export function buildFileGraph(
  repo: RepoHandle,
  filePath: string,
  fixedNames: readonly string[],
  options: FileGraphOptions = {},
): FileGraphPayload {
  const includeRemotes = options.includeRemotes ?? false;
  const follow = options.follow ?? false;
  const maxCommits = options.maxCommits ?? 2000;

  const store = repo.store();
  const ts = store.ts;
  const warnings: string[] = [];

  const records = repo.fileHistory(filePath, maxCommits, follow);
  if (!records.length) {
    return {
      path: filePath,
      follow,
      lanes: [],
      nodes: [],
      edges: [],
      commits: [],
      range: { minTs: 0, maxTs: 0 },
      warnings: ['没有找到该文件的改动记录（确认路径是否正确、是否存在于历史中）。'],
      stats: { commits: 0, lanes: 0, branches: 0 },
    };
  }

  const recordByIdx = new Map<number, FileRecord>();
  for (const rec of records) {
    const i = store.get(rec.sha);
    if (i !== undefined) recordByIdx.set(i, rec);
  }
  if (recordByIdx.size < records.length) {
    warnings.push('部分改动提交不在已加载的历史窗口内，已被忽略。');
  }

  const allLanes = buildLanes(repo, fixedNames, includeRemotes);

  const fileIndices = [...recordByIdx.keys()].sort((a, b) => ts[a] - ts[b]);
  const fileSet = new Set(fileIndices);

  // -- 规则 7 上半：谁改的，谁只是承载 --------------------------------
  // 一个提交归给"第一父链上包含它、且最具体"的那条分支；固定分支优先，
  // 同级里可达集合小的更具体。只通过合并到达的算继承，不算作者。
  const bestAuthor = new Map<number, { lane: LaneInfo; key: number[] }>();
  for (const lane of allLanes) {
    if (lane.tip === null) continue;
    if (!fileIndices.some((i) => lane.reach.has(i))) continue;
    const chain = store.firstParentChain(lane.tip);
    for (let depth = 0; depth < chain.length; depth++) {
      const commit = chain[depth];
      if (!fileSet.has(commit)) continue;
      const current = bestAuthor.get(commit);
      const key = [lane.kind === 'fixed' ? 0 : 1, lane.reach.size, -depth];
      if (current === undefined || compare(key, current.key) < 0) {
        bestAuthor.set(commit, { lane, key });
      }
    }
  }

  // 按分支的**对象身份**分组（等价于 Python 的 id(lane)），
  // 不能用 lane.lane 当 key —— 那个序号后面会被重排。
  const authorHits = new Map<LaneInfo, number[]>();
  for (const [commit, entry] of bestAuthor) {
    const list = authorHits.get(entry.lane);
    if (list) list.push(commit);
    else authorHits.set(entry.lane, [commit]);
  }

  const authors: LaneInfo[] = [];
  for (const lane of allLanes) {
    lane.hits = (authorHits.get(lane) ?? []).slice().sort((a, b) => ts[a] - ts[b]);
    if (lane.hits.length) authors.push(lane);
  }

  const carriers: LaneInfo[] = [];
  if (authors.length) {
    const authorSet = new Set(authors);
    for (const lane of allLanes) {
      if (authorSet.has(lane) || lane.kind !== 'fixed') continue;
      lane.carrierHits = fileIndices.filter((i) => lane.reach.has(i));
      if (lane.carrierHits.length) carriers.push(lane);
    }
  }

  const contributing: LaneInfo[] = [...carriers, ...authors];
  if (!contributing.length) {
    for (const lane of allLanes) {
      lane.hits = fileIndices.filter((i) => lane.reach.has(i));
      if (lane.hits.length) contributing.push(lane);
    }
    if (contributing.length) {
      warnings.push('未找到该文件专属的改动分支，改为展示包含这些提交的所有分支。');
    }
  }

  // 固定分支保持在用户给的顺序上（lane 是原始序号，这里还没重排）；
  // 其余按"最早改到这个文件的时间"排。
  const sortKey = (lane: LaneInfo): number[] => {
    if (lane.kind === 'fixed') return [0, lane.lane, 0];
    const first = lane.hits.length ? Math.min(...lane.hits.map((i) => ts[i])) : 0;
    return [1, first, 0];
  };
  contributing.sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    const c = compare(ka, kb);
    if (c !== 0) return c;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  contributing.forEach((lane, i) => {
    lane.lane = i;
    lane.color = laneColor(i, lane.kind === 'fixed');
  });

  const laneNameByIndex = new Map(contributing.map((lane) => [lane.lane, lane.name]));
  const authorLanes = contributing.filter((lane) => lane.hits.length);
  const authorNameOfCommit = new Map<number, string>();
  for (const [commit, entry] of bestAuthor) authorNameOfCommit.set(commit, entry.lane.name);

  let minTs: number | null = null;
  let maxTs: number | null = null;
  const bump = (value: number | null): void => {
    if (value === null) return;
    if (minTs === null || value < minTs) minTs = value;
    if (maxTs === null || value > maxTs) maxTs = value;
  };

  // -- 节点 ----------------------------------------------------------
  const nodes: NodePayload[] = [];
  for (const lane of contributing) {
    const hits = [...new Set(lane.hits)].sort((a, b) => ts[a] - ts[b]);
    for (const idx of hits) {
      const rec = recordByIdx.get(idx);
      nodes.push({
        lane: lane.lane,
        sha: store.sha[idx],
        short: store.short(idx),
        ts: ts[idx],
        author: store.author[idx],
        subject: store.subject[idx],
        kind: 'commit',
        status: statusText(rec?.changes ?? []),
        x: 0,
        labels: [],
      });
      bump(ts[idx]);
    }
  }

  // -- 规则 7 下半：传播边 ------------------------------------------
  const chainMerges = new Map<number, number[]>();
  const chainMergeTs = new Map<number, number[]>();
  for (const lane of contributing) {
    if (lane.tip === null) {
      chainMerges.set(lane.lane, []);
      chainMergeTs.set(lane.lane, []);
      continue;
    }
    const merges = store
      .firstParentChain(lane.tip)
      .filter((m) => store.parents[m].length > 1)
      .sort((a, b) => ts[a] - ts[b]);
    chainMerges.set(lane.lane, merges);
    chainMergeTs.set(lane.lane, merges.map((m) => ts[m]));
  }

  const forwardCache = new Map<number, Set<number>>();
  const forward = (idx: number): Set<number> => {
    let cached = forwardCache.get(idx);
    if (cached === undefined) {
      cached = store.forward(idx);
      forwardCache.set(idx, cached);
    }
    return cached;
  };

  const edgeMap = new Map<string, EdgePayload & { fromTs: number; ts: number; fromSha: string }>();

  for (const lane of authorLanes) {
    for (const idx of lane.hits) {
      const fwd = forward(idx);
      for (const target of contributing) {
        if (target === lane || !target.reach.has(idx)) continue;
        const candidates = chainMerges.get(target.lane) ?? [];
        const start = candidates.length
          ? lowerBound(chainMergeTs.get(target.lane) as number[], ts[idx])
          : 0;

        let entry: number | null = null;
        for (const m of candidates.slice(start, start + MAX_SCAN)) {
          const parents = store.parents[m];
          // 改动必须是从**非第一父**带进来的：如果第一父里已经有了，
          // 那这条分支早就有了这个改动，这次合并跟它没关系。
          if (!fwd.has(parents[0]) && parents.slice(1).some((p) => fwd.has(p))) {
            entry = m;
            break;
          }
        }

        if (entry !== null) {
          const key = `merge|${lane.lane}|${target.lane}|${store.sha[entry]}`;
          const existing = edgeMap.get(key);
          if (existing === undefined) {
            edgeMap.set(key, {
              kind: 'merge',
              fromLane: lane.lane,
              toLane: target.lane,
              fromTs: ts[idx],
              ts: ts[entry],
              fromSha: store.sha[idx],
              sha: store.sha[entry],
              short: store.short(entry),
              subject: store.subject[entry],
              author: store.author[entry],
              x1: 0,
              x2: 0,
              targetVersion: null,
            });
          } else if (ts[idx] < existing.fromTs) {
            existing.fromTs = ts[idx];
            existing.fromSha = store.sha[idx];
          }
          bump(ts[entry]);
        } else {
          // 可达但找不到"带入"的合并：画成分叉线（改动是自己这里产生、后被别人继承）
          edgeMap.set(`fork|${lane.lane}|${target.lane}|${store.sha[idx]}`, {
            kind: 'fork',
            fromLane: lane.lane,
            toLane: target.lane,
            fromTs: ts[idx],
            ts: ts[idx],
            fromSha: store.sha[idx],
            sha: store.sha[idx],
            short: store.short(idx),
            subject: store.subject[idx],
            author: store.author[idx],
            x1: 0,
            x2: 0,
            targetVersion: null,
          });
        }
      }
    }
  }

  const edges = [...edgeMap.values()];

  // -- tag 当 label --------------------------------------------------
  const labelsBySha = new Map<string, string[]>();
  for (const tag of repo.tags()) {
    if (store.get(tag.sha) === undefined) continue;
    const list = labelsBySha.get(tag.sha);
    if (list) list.push(tag.name);
    else labelsBySha.set(tag.sha, [tag.name]);
  }

  // -- 轨道 payload --------------------------------------------------
  const versionsByLane = new Map<number, VersionPayload[]>();
  const lanePayload: LanePayload[] = [];

  for (const lane of contributing) {
    const hits = [...new Set(lane.hits)].sort((a, b) => ts[a] - ts[b]);
    const isAuthor = lane.hits.length > 0;

    const firstTs = hits.length ? ts[hits[0]] : minOr(store, lane.carrierHits, lane.tipTs);
    const lastTs = hits.length ? ts[hits[hits.length - 1]] : maxOr(store, lane.carrierHits, lane.tipTs);
    let startTs = lane.fork !== null ? ts[lane.fork] : firstTs;
    startTs = Math.min(startTs, firstTs);
    // 作者轨道要一直画到分支 tip；承载轨道只需画到把改动带进来的那次合并。
    const endTs = isAuthor ? Math.max(lane.tipTs, lastTs) : Math.max(lastTs, firstTs);
    bump(startTs);
    bump(endTs);

    // 版本号是 ClearCase 语义：/<分支名>/<n>，从 1 开始按时间递增
    const versions: VersionPayload[] = hits.map((idx, i) => {
      const rec = recordByIdx.get(idx);
      return {
        n: i + 1,
        sha: store.sha[idx],
        short: store.short(idx),
        ts: ts[idx],
        subject: store.subject[idx],
        author: store.author[idx],
        status: statusText(rec?.changes ?? []),
        labels: [...(labelsBySha.get(store.sha[idx]) ?? [])].sort(),
        x: 0,
      };
    });
    versionsByLane.set(lane.lane, versions);

    lanePayload.push({
      name: lane.name,
      lane: lane.lane,
      kind: lane.kind,
      color: lane.color,
      remote: lane.remote,
      role: isAuthor ? 'author' : 'carrier',
      versions,
      tip: lane.tip !== null ? store.sha[lane.tip] : null,
      tipShort: lane.tip !== null ? store.short(lane.tip) : null,
      tipTs: lane.tipTs,
      tipSubject: lane.tip !== null ? store.subject[lane.tip] : '',
      tipAuthor: lane.tip !== null ? store.author[lane.tip] : '',
      startTs,
      ownCount: hits.length,
      reachCount: lane.reach.size,
      forkShort: lane.fork !== null ? store.short(lane.fork) : null,
      forkTs: lane.fork !== null ? ts[lane.fork] : null,
      parentName: lane.parentName,
      mergedInto: [],
      incoming: [],
      merged: lane.fork !== null,
      nodeCount: hits.length,
      x1: 0,
      x2: 0,
      forkX: null,
    });
  }

  if (minTs === null) {
    const only = fileIndices.length ? ts[fileIndices[0]] : 0;
    minTs = only;
    maxTs = only;
  }

  // -- 合并箭头落在哪：那次合并之后目标分支上的第一个版本 -------------
  for (const edge of edges) {
    edge.targetVersion = null;
    if (edge.kind !== 'merge') continue;
    for (const version of versionsByLane.get(edge.toLane) ?? []) {
      if (version.ts >= edge.ts) {
        edge.targetVersion = {
          lane: edge.toLane,
          sha: version.sha,
          short: version.short,
          n: version.n,
          ts: version.ts,
        };
        break;
      }
    }
  }

  const span = Math.max(1, (maxTs ?? 0) - (minTs ?? 0));
  const base = minTs ?? 0;
  const norm = (value: number | null | undefined): number => {
    const v = ((value ?? 0) - base) / span;
    return Math.round(v * 1e7) / 1e7;
  };

  for (const node of nodes) {
    node.x = norm(node.ts);
    node.labels = [...(labelsBySha.get(node.sha) ?? [])].sort();
  }

  const deduped: EdgePayload[] = [];
  const seenEdges = new Set<string>();
  for (const e of edgeMap.values()) {
    const x1 = norm(e.fromTs);
    const x2 = norm(e.ts);
    const key = `${e.kind}|${e.fromLane}|${e.toLane}|${e.sha}|${x1}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    deduped.push({
      kind: e.kind,
      fromLane: e.fromLane,
      toLane: e.toLane,
      sha: e.sha,
      short: e.short,
      subject: e.subject,
      author: e.author,
      x1,
      x2,
      targetVersion: e.targetVersion,
    });
  }

  for (const payload of lanePayload) {
    payload.x1 = norm(payload.startTs);
    payload.x2 = norm(payload.tipTs);
    payload.forkX = payload.forkTs ? norm(payload.forkTs) : null;
    for (const version of payload.versions) version.x = norm(version.ts);
  }

  // -- 提交表 --------------------------------------------------------
  const promotionBySha = new Map<string, unknown[]>();
  for (const e of deduped) {
    const list = promotionBySha.get(e.sha) ?? [];
    list.push({
      kind: e.kind,
      intoBranch: laneNameByIndex.get(e.toLane) ?? '',
      sha: e.sha,
      short: e.short,
      subject: e.subject,
    });
    promotionBySha.set(e.sha, list);
  }

  const originCache = new Map<number, string | null>();
  const commitRows: CommitRowPayload[] = [];
  for (const rec of records.slice().sort((a, b) => b.ts - a.ts)) {
    const idx = store.get(rec.sha);
    const containing = allLanes
      .filter((lane) => idx !== undefined && lane.reach.has(idx))
      .map((lane) => lane.name)
      .sort((a, b) => {
        const fa = fixedNames.includes(a) ? 0 : 1;
        const fb = fixedNames.includes(b) ? 0 : 1;
        if (fa !== fb) return fa - fb;
        return a < b ? -1 : a > b ? 1 : 0;
      });

    let origin: string | null = null;
    if (idx !== undefined) {
      if (!originCache.has(idx)) {
        let name = authorNameOfCommit.get(idx) ?? null;
        if (name === null) name = laneContaining(allLanes, idx, true)?.name ?? null;
        originCache.set(idx, name);
      }
      origin = originCache.get(idx) ?? null;
    }

    commitRows.push({
      sha: rec.sha,
      parents: rec.parents,
      ts: rec.ts,
      author: rec.author,
      subject: rec.subject,
      changes: rec.changes,
      short: rec.sha.slice(0, 8),
      status: statusText(rec.changes),
      labels: [...(labelsBySha.get(rec.sha) ?? [])].sort(),
      containing,
      origin: origin ?? containing[0] ?? null,
      promotion: promotionBySha.get(rec.sha) ?? [],
    });
  }

  let tagCount = 0;
  for (const list of labelsBySha.values()) tagCount += list.length;
  const branchSet = new Set<string>();
  for (const row of commitRows) for (const name of row.containing) branchSet.add(name);

  return {
    path: filePath,
    follow,
    lanes: lanePayload,
    nodes,
    edges: deduped,
    commits: commitRows,
    range: { minTs: base, maxTs: maxTs ?? base },
    warnings,
    stats: {
      commits: commitRows.length,
      lanes: lanePayload.length,
      tags: tagCount,
      branches: branchSet.size,
    },
  };
}

// ---------------------------------------------------------------------------

function compare(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

/** `bisect.bisect_left`：第一个 >= value 的下标。 */
function lowerBound(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function minOr(store: CommitStore, indices: readonly number[], fallback: number): number {
  if (!indices.length) return fallback;
  let best = store.ts[indices[0]];
  for (const i of indices) if (store.ts[i] < best) best = store.ts[i];
  return best;
}

function maxOr(store: CommitStore, indices: readonly number[], fallback: number): number {
  if (!indices.length) return fallback;
  let best = store.ts[indices[0]];
  for (const i of indices) if (store.ts[i] > best) best = store.ts[i];
  return best;
}
