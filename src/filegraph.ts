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
import {
  BranchScope,
  ChangeInfo,
  FileRecord,
  RefInfo,
  RepoHandle,
  branchPart,
  selectRefs,
} from './repo';

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

/** 合并箭头落在目标轨道上的那个节点——目标分支上的合并节点。 */
export interface TargetNode {
  lane: number;
  sha: string;
  short: string;
  kind: 'merge';
  ts: number;
  n: number | null;
}

/** 合并节点是从哪条轨道的哪个节点把改动带进来的。 */
export interface NodeVia {
  lane: number;
  name: string;
  sha: string;
  short: string;
  kind: 'version' | 'merge';
  n: number | null;
}

export interface EdgePayload {
  kind: 'merge' | 'fork';
  fromLane: number;
  toLane: number;
  /** 源端节点的 sha（版本节点就是那个提交；合并节点就是那次合并）。 */
  fromSha: string;
  fromKind: 'version' | 'merge' | 'fork';
  /** 源端是版本节点时的版本号（/分支/n）；否则为 null。 */
  fromN: number | null;
  /** "merge" 边：合并提交本身。"fork" 边：分叉点提交。 */
  sha: string;
  short: string;
  subject: string;
  author: string;
  x1: number;
  x2: number;
  targetNode: TargetNode | null;
}

export interface NodePayload {
  lane: number;
  sha: string;
  short: string;
  ts: number;
  author: string;
  subject: string;
  /** version = 本分支自己改了这个文件的提交；merge = 把改动带进本分支的那次合并。 */
  kind: 'version' | 'merge';
  /** 版本号（ClearCase 的 /分支/n）；合并节点为 null。 */
  n: number | null;
  status: string;
  x: number;
  labels: string[];
  via: NodeVia | null;
}

export interface LanePayload {
  name: string;
  lane: number;
  kind: 'fixed' | 'other';
  color: string;
  remote: boolean;
  role: 'author' | 'carrier';
  versions: VersionPayload[];
  /** 本轨道上的合并节点个数（把别人的改动带进来的合并）。 */
  mergeCount: number;
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
  /** 本图关心的是哪个范围的分支（本地 / 远端 / 全部）。 */
  scope: BranchScope;
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
  /** 看哪些分支：本地 / 远端 / 全部。默认本地。 */
  scope?: BranchScope;
  /** @deprecated 旧设置项，为 true 等价于 `scope: 'all'`。 */
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
  scope: BranchScope = 'local',
): LaneInfo[] {
  const store = repo.store();
  const refs = selectRefs(repo.refs(), scope);
  const byName = new Map(refs.map((r) => [r.name, r]));

  const allLanes: LaneInfo[] = [];
  const taken = new Set<string>();

  for (const name of fixedNames) {
    const ref = matchFixedRef(refs, byName, name);
    if (!ref || taken.has(ref.name)) continue;
    // 注意：先占位再看 tip —— 名字重复或指向未知提交时，它也不该掉到"其他分支"里去
    taken.add(ref.name);
    const tip = store.get(ref.sha);
    if (tip === undefined) continue;
    const lane = new LaneInfo(ref.name, 'fixed');
    lane.tip = tip;
    lane.tipTs = store.ts[tip];
    lane.remote = ref.remote;
    allLanes.push(lane);
  }

  for (const ref of refs) {
    if (taken.has(ref.name)) continue;
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

/**
 * 固定分支名 → 这个范围里真存在的 ref。
 *
 * 先精确同名（`dev` 命中本地 `dev`；用户手写成 `origin/dev` 也能直接命中），
 * 再退回“远端轨道用名字后半段匹配”——`只看远程` 时发布层级全是 `origin/*`，
 * 不这么匹配就一条固定分支也认不出来。
 */
function matchFixedRef(
  refs: readonly RefInfo[],
  byName: Map<string, RefInfo>,
  name: string,
): RefInfo | undefined {
  const exact = byName.get(name);
  if (exact) return exact;
  return refs.find((ref) => ref.remote && branchPart(ref.name) === name);
}

export function buildFileGraph(
  repo: RepoHandle,
  filePath: string,
  fixedNames: readonly string[],
  options: FileGraphOptions = {},
): FileGraphPayload {
  const scope: BranchScope = options.scope ?? (options.includeRemotes ? 'all' : 'local');
  const follow = options.follow ?? false;
  const maxCommits = options.maxCommits ?? 2000;

  const store = repo.store();
  const ts = store.ts;
  const warnings: string[] = [];

  const records = repo.fileHistory(filePath, maxCommits, follow);
  if (!records.length) {
    return {
      path: filePath,
      scope,
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

  const allLanes = buildLanes(repo, fixedNames, scope);

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
  const authorNameOfCommit = new Map<number, string>();
  for (const [commit, entry] of bestAuthor) authorNameOfCommit.set(commit, entry.lane.name);

  let minTs: number | null = null;
  let maxTs: number | null = null;
  const bump = (value: number | null): void => {
    if (value === null) return;
    if (minTs === null || value < minTs) minTs = value;
    if (maxTs === null || value > maxTs) maxTs = value;
  };

  // -- 每条轨道自己的节点 ---------------------------------------------
  // 一条轨道上有两种东西：
  //   version 这条分支**自己改了这个文件**的提交（ClearCase 的 /分支/n）
  //   merge   把别的轨道的改动**带进这条分支**的那次合并
  // 有了合并节点，"a 合并到 b"就落在 b 这条轨道的具体位置上：点它就能看 b 上
  // 这个文件合并前后的对比，而不用去追那些横穿全图的连线。
  const hitsByLane = new Map<number, number[]>();
  for (const lane of contributing) {
    hitsByLane.set(lane.lane, [...new Set(lane.hits)].sort((a, b) => ts[a] - ts[b]));
  }
  const versionNoByLane = new Map<number, Map<number, number>>();
  for (const [laneIndex, hits] of hitsByLane) {
    versionNoByLane.set(laneIndex, new Map(hits.map((commit, i) => [commit, i + 1])));
  }
  const authorLaneByCommit = new Map<number, LaneInfo>();
  for (const [commit, entry] of bestAuthor) authorLaneByCommit.set(commit, entry.lane);
  const contributingSet = new Set(contributing);

  // 每条轨道第一父链上的合并，按时间升序（找"带进来的那次合并"要在这上面扫）
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

  const ancestorCache = new Map<number, Set<number>>();
  const ancestors = (idx: number): Set<number> => {
    let cached = ancestorCache.get(idx);
    if (cached === undefined) {
      cached = store.ancestors(idx);
      ancestorCache.set(idx, cached);
    }
    return cached;
  };

  /**
   * 把 `commit` 带进 `lane` 的那次合并 —— 规则 7 下半的老判据，原样保留。
   *
   * 改动必须是从**非第一父**带进来的：第一父里已经有了，说明这条分支早就有了它，
   * 这次合并跟它没关系。结果缓存起来，后面的交接判断会反复问同一件事。
   */
  const entryCache = new Map<string, number | null>();
  const entryMerge = (lane: LaneInfo, commit: number): number | null => {
    const key = `${lane.lane}|${commit}`;
    const cached = entryCache.get(key);
    if (cached !== undefined) return cached;
    let found: number | null = null;
    const candidates = chainMerges.get(lane.lane) ?? [];
    if (candidates.length) {
      const fwd = forward(commit);
      const times = chainMergeTs.get(lane.lane) as number[];
      const start = lowerBound(times, ts[commit]);
      for (const m of candidates.slice(start, start + MAX_SCAN)) {
        const parents = store.parents[m];
        if (!fwd.has(parents[0]) && parents.slice(1).some((p) => fwd.has(p))) {
          found = m;
          break;
        }
      }
    }
    entryCache.set(key, found);
    return found;
  };

  interface Handoff {
    lane: LaneInfo;
    kind: 'version' | 'merge';
    sha: string;
    ts: number;
    n: number | null;
  }

  /**
   * 改动是在哪儿**交到**这条轨道手上的。
   *
   * 优先认**最近一次交接**：dev → uat → release 这样一趟走上来的改动，release 上的
   * 箭头应该来自 uat 的合并节点，而不是从 dev 一路拉一根横穿全图的长线回到源头。
   * 于是每条箭头只连相邻两条轨道，"一堆交叉连线"就散了；真的没有中间轨道接力时
   * （比如 a 直接合进 b），才落回作者那根版本节点上。
   */
  const handoffOf = (lane: LaneInfo, commit: number, m: number): Handoff | null => {
    const parents = store.parents[m];
    const fwd = forward(commit);
    const intoAnc = ancestors(parents[0]);
    let best: Handoff | null = null;
    for (let k = 1; k < parents.length; k++) {
      if (!fwd.has(parents[k])) continue;
      const fromAnc = ancestors(parents[k]);
      for (const other of contributing) {
        if (other.lane === lane.lane) continue;
        const relay = entryMerge(other, commit);
        if (relay === null || relay === m) continue;
        // 中间这条轨道确实先拿到了改动，而这条轨道当时还没有它
        if (!fromAnc.has(relay) || intoAnc.has(relay)) continue;
        if (best === null || ts[relay] > best.ts) {
          best = { lane: other, kind: 'merge', sha: store.sha[relay], ts: ts[relay], n: null };
        }
      }
    }
    if (best) return best;

    const author = authorLaneByCommit.get(commit);
    if (author === undefined || !contributingSet.has(author)) return null;
    return {
      lane: author,
      kind: 'version',
      sha: store.sha[commit],
      ts: ts[commit],
      n: versionNoByLane.get(author.lane)?.get(commit) ?? null,
    };
  };

  /** 一条轨道 × 一次"带进来"的合并 = 一个合并节点。 */
  interface MergePoint {
    lane: LaneInfo;
    merge: number;
    sources: Handoff[];
  }

  const mergePoints = new Map<string, MergePoint>();
  for (const lane of contributing) {
    if (lane.tip === null) continue;
    const own = new Set(hitsByLane.get(lane.lane) ?? []);
    for (const commit of fileIndices) {
      // 自己改的会画成版本节点，这里只关心"别人改的、被我合并进来的"
      if (own.has(commit) || !lane.reach.has(commit)) continue;
      const m = entryMerge(lane, commit);
      if (m === null) continue;
      const key = `${lane.lane}|${m}`;
      let point = mergePoints.get(key);
      if (point === undefined) {
        point = { lane, merge: m, sources: [] };
        mergePoints.set(key, point);
      }
      const source = handoffOf(lane, commit, m);
      if (source === null) continue;
      if (point.sources.some((s) => s.lane.lane === source.lane.lane && s.sha === source.sha)) {
        continue;
      }
      point.sources.push(source);
      bump(ts[m]);
    }
  }

  const points = [...mergePoints.values()].sort(
    (a, b) => a.lane.lane - b.lane.lane || ts[a.merge] - ts[b.merge],
  );
  for (const point of points) {
    point.sources.sort((a, b) => a.lane.lane - b.lane.lane || a.ts - b.ts);
  }

  /** 每条轨道上的合并节点（画轨道范围、数合并次数都要用）。 */
  const mergePointsFor = new Map<number, MergePoint[]>();
  for (const point of points) {
    const list = mergePointsFor.get(point.lane.lane);
    if (list) list.push(point);
    else mergePointsFor.set(point.lane.lane, [point]);
  }

  // -- 节点 ----------------------------------------------------------
  const nodes: NodePayload[] = [];
  for (const lane of contributing) {
    const hits = hitsByLane.get(lane.lane) ?? [];
    const numbers = versionNoByLane.get(lane.lane);
    for (const idx of hits) {
      const rec = recordByIdx.get(idx);
      nodes.push({
        lane: lane.lane,
        sha: store.sha[idx],
        short: store.short(idx),
        ts: ts[idx],
        author: store.author[idx],
        subject: store.subject[idx],
        kind: 'version',
        n: numbers?.get(idx) ?? null,
        status: statusText(rec?.changes ?? []),
        x: 0,
        labels: [],
        via: null,
      });
      bump(ts[idx]);
    }
  }

  for (const point of points) {
    const m = point.merge;
    const primary = point.sources[0] ?? null;
    nodes.push({
      lane: point.lane.lane,
      sha: store.sha[m],
      short: store.short(m),
      ts: ts[m],
      author: store.author[m],
      subject: store.subject[m],
      kind: 'merge',
      n: null,
      status: statusText(recordByIdx.get(m)?.changes ?? []),
      x: 0,
      labels: [],
      via:
        primary === null
          ? null
          : {
              lane: primary.lane.lane,
              name: primary.lane.name,
              sha: primary.sha,
              short: primary.sha.slice(0, 8),
              kind: primary.kind,
              n: primary.n,
            },
    });
  }
  nodes.sort((a, b) => a.lane - b.lane || a.ts - b.ts || (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0));

  // -- 边：合并箭头 + 分叉线 -----------------------------------------
  interface RawEdge {
    edge: EdgePayload;
    x1Ts: number;
    x2Ts: number;
  }

  const rawEdges: RawEdge[] = [];
  const seenEdges = new Set<string>();

  for (const point of points) {
    const mergeSha = store.sha[point.merge];
    const target: TargetNode = {
      lane: point.lane.lane,
      sha: mergeSha,
      short: store.short(point.merge),
      kind: 'merge',
      ts: ts[point.merge],
      n: null,
    };
    for (const source of point.sources) {
      const key = `merge|${source.lane.lane}|${point.lane.lane}|${source.sha}|${mergeSha}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      rawEdges.push({
        x1Ts: source.ts,
        x2Ts: ts[point.merge],
        edge: {
          kind: 'merge',
          fromLane: source.lane.lane,
          toLane: point.lane.lane,
          fromSha: source.sha,
          fromKind: source.kind,
          fromN: source.n,
          sha: mergeSha,
          short: store.short(point.merge),
          subject: store.subject[point.merge],
          author: store.author[point.merge],
          x1: 0,
          x2: 0,
          targetNode: target,
        },
      });
    }
  }

  // 分叉线：每条轨道一根，从它父分支的轨道拉过来，画在分支点那一行。
  // 以前是"每个版本 × 每条继承它的轨道"各拉一根，图上一半的线都是这么来的。
  const laneByName = new Map(contributing.map((lane) => [lane.name, lane]));
  for (const lane of contributing) {
    if (lane.fork === null || !lane.parentName) continue;
    const parent = laneByName.get(lane.parentName);
    if (parent === undefined || parent.lane === lane.lane) continue;
    const key = `fork|${parent.lane}|${lane.lane}|${store.sha[lane.fork]}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    rawEdges.push({
      x1Ts: ts[lane.fork],
      x2Ts: ts[lane.fork],
      edge: {
        kind: 'fork',
        fromLane: parent.lane,
        toLane: lane.lane,
        fromSha: store.sha[lane.fork],
        fromKind: 'fork',
        fromN: null,
        sha: store.sha[lane.fork],
        short: store.short(lane.fork),
        subject: store.subject[lane.fork],
        author: store.author[lane.fork],
        x1: 0,
        x2: 0,
        targetNode: null,
      },
    });
  }

  // -- tag 当 label --------------------------------------------------
  const labelsBySha = new Map<string, string[]>();
  for (const tag of repo.tags()) {
    if (store.get(tag.sha) === undefined) continue;
    const list = labelsBySha.get(tag.sha);
    if (list) list.push(tag.name);
    else labelsBySha.set(tag.sha, [tag.name]);
  }

  // -- 轨道 payload --------------------------------------------------
  const lanePayload: LanePayload[] = [];
  /** 轨道上下端（原始时间戳）：含版本节点和合并节点，最后统一归一化。 */
  const laneTrack = new Map<number, { start: number; end: number }>();

  for (const lane of contributing) {
    const hits = hitsByLane.get(lane.lane) ?? [];
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

    // 轨道画到哪：自己的版本节点 + 合并节点，都算在这条轨道的故事里。
    // （都没有时退回“分叉点 → 把改动带进来的那次合并”这段范围。）
    const mergeStamps = (mergePointsFor.get(lane.lane) ?? []).map((p) => ts[p.merge]);
    const stamps = [...versions.map((v) => v.ts), ...mergeStamps];
    laneTrack.set(lane.lane, {
      start: stamps.length ? Math.min(...stamps) : startTs,
      end: stamps.length ? Math.max(...stamps) : endTs,
    });

    lanePayload.push({
      name: lane.name,
      lane: lane.lane,
      kind: lane.kind,
      color: lane.color,
      remote: lane.remote,
      role: isAuthor ? 'author' : 'carrier',
      versions,
      mergeCount: mergeStamps.length,
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

  // 边：同时算好归一化后的两端，以及"合并节点落在哪个版本之前"的源端信息
  const edges: EdgePayload[] = rawEdges.map((item) => ({
    ...item.edge,
    x1: norm(item.x1Ts),
    x2: norm(item.x2Ts),
  }));

  for (const payload of lanePayload) {
    const track = laneTrack.get(payload.lane) ?? { start: payload.startTs, end: payload.startTs };
    payload.x1 = norm(track.start);
    payload.x2 = norm(Math.max(track.start, track.end));
    payload.forkX = payload.forkTs ? norm(payload.forkTs) : null;
    for (const version of payload.versions) version.x = norm(version.ts);
  }

  // -- 提交表 --------------------------------------------------------
  const promotionBySha = new Map<string, unknown[]>();
  for (const e of edges) {
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
  const fixedLaneNames = new Set(allLanes.filter((l) => l.kind === 'fixed').map((l) => l.name));
  const commitRows: CommitRowPayload[] = [];
  for (const rec of records.slice().sort((a, b) => b.ts - a.ts)) {
    const idx = store.get(rec.sha);
    const containing = allLanes
      .filter((lane) => idx !== undefined && lane.reach.has(idx))
      .map((lane) => lane.name)
      .sort((a, b) => {
        const fa = fixedLaneNames.has(a) ? 0 : 1;
        const fb = fixedLaneNames.has(b) ? 0 : 1;
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
    scope,
    follow,
    lanes: lanePayload,
    nodes,
    edges,
    commits: commitRows,
    range: { minTs: base, maxTs: maxTs ?? base },
    warnings,
    stats: {
      commits: commitRows.length,
      lanes: lanePayload.length,
      tags: tagCount,
      branches: branchSet.size,
      versions: lanePayload.reduce((sum, lane) => sum + lane.versions.length, 0),
      merges: points.length,
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
