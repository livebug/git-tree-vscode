/**
 * 分支谱系：谁从谁分出来，以及每个分支"自己做了哪些提交"。
 *
 * 移植自 git-tree/backend/layout.py 的 `_resolve_lineage` 及其辅助函数。
 * 语义说明见 git-tree/DEVELOPMENT.md §4 与本仓库 test/rules.test.ts 的断言。
 *
 * ## 分叉点怎么算（规则 1）
 *
 * **不是**"最近的共同祖先"，而是：从本分支的 tip 沿**第一父链**往根走，
 * 第一个也出现在对方第一父链上的提交。
 *
 * 区别很大：dev 和 master 互相回灌之后，"最近的共同祖先"会变成 master
 * 最后一次推的东西，而不是 dev 从哪切出来的。
 *
 * ## 谁是父分支（规则 2/3）
 *
 * 候选按 `(-depth, pivot === other.tip, isFixed, -lane)` **降序**排，取第一个
 * 让 `own` 非空的。因为整体降序，`-depth` 降序 = depth 升序 = **分叉点离 tip
 * 越近越优先**。depth 必须是第一位——曾经把 tipmatch/isFixed 排前面，结果
 * uat 认了 master、conf-x 也认了 master。
 *
 * 另外：固定分支的候选只取 lane 序号比它小的（用户排的顺序就是发布层级），
 * 而 `own` 为空的候选直接跳过——这条同时挡掉了"子分支反过来认爹"。
 *
 * ## 两条分支各自拥有什么（规则 4）
 *
 * - 开发分支：`own = reach - ancestors(分叉点)`，即它自己新做出来的提交
 * - 固定分支：`own = 自己的第一父链 - 父分支的第一父链`，读作"这条集成线比上一条多了什么"
 */

import { CommitStore } from './gitstore';

export const LANE_COLORS = [
  '#e5484d',
  '#f76b15',
  '#e2a336',
  '#46a758',
  '#12a594',
  '#0090ff',
  '#3e63dd',
  '#8e4ec6',
  '#d6409f',
  '#e93d82',
  '#c2410c',
  '#0d9488',
  '#7c3aed',
  '#a18072',
  '#4d7c0f',
  '#0ea5e9',
];

export const FIXED_COLORS = ['#e5484d', '#f76b15', '#0090ff', '#8e4ec6', '#46a758', '#d6409f'];

export type LaneKind = 'fixed' | 'other';

export function laneColor(index: number, fixed: boolean): string {
  if (fixed) return FIXED_COLORS[index % FIXED_COLORS.length];
  return LANE_COLORS[index % LANE_COLORS.length];
}

/** 一条被画出来的分支。字段名对齐 Python 侧（下划线转驼峰）。 */
export class LaneInfo {
  lane = 0;
  tip: number | null = null;
  tipTs = 0;
  /** 这条分支可达的全部提交。 */
  reach = new Set<number>();
  /** 这条分支"自己新做出来"的提交。 */
  own = new Set<number>();
  parentName: string | null = null;
  /** 分叉点：`own` 里最早那个提交的第一父。 */
  fork: number | null = null;
  mergedInto: unknown[] = [];
  color = '#888888';
  remote = false;
  /** 这条分支上真正改动过目标文件的提交（文件视图用）。 */
  hits: number[] = [];
  /** 只是继承了这个改动的提交（承载分支用）。 */
  carrierHits: number[] = [];

  constructor(
    readonly name: string,
    readonly kind: LaneKind,
  ) {}
}

/** 把 `{status, path}` 列表转成中文单字状态（规则无关，纯展示）。 */
export function statusText(changes: readonly { status?: string }[]): string {
  if (!changes.length) return '';
  const code = String(changes[0].status ?? '').slice(0, 1);
  const table: Record<string, string> = {
    A: '新增',
    M: '修改',
    D: '删除',
    R: '重命名',
    C: '复制',
    T: '类型变更',
  };
  return table[code] ?? code;
}

/**
 * `targetReach` 里最早的、把 `sourceReach` 拉进来的那个合并提交。
 *
 * 已经在 `sourceReach` 里的合并会被忽略：那是它自己历史上合并了别的分支，
 * 不代表它在往上层合并。
 */
export function earliestMergeInto(
  store: CommitStore,
  targetReach: Set<number>,
  sourceReach: Set<number>,
): number | null {
  let best: number | null = null;
  let bestTs: number | null = null;
  for (const m of store.mergeIds) {
    if (!targetReach.has(m) || sourceReach.has(m)) continue;
    if (bestTs !== null && store.ts[m] >= bestTs) continue;
    for (const p of store.parents[m].slice(1)) {
      if (sourceReach.has(p)) {
        best = m;
        bestTs = store.ts[m];
        break;
      }
    }
  }
  return best;
}

export function resolveLineage(lanes: LaneInfo[], store: CommitStore): void {
  const ts = store.ts;
  const ancestorCache = new Map<number, Set<number>>();
  const ancestors = (idx: number): Set<number> => {
    let cached = ancestorCache.get(idx);
    if (cached === undefined) {
      cached = store.ancestors(idx);
      ancestorCache.set(idx, cached);
    }
    return cached;
  };

  const chains = new Map<number, number[]>();
  const chainSets = new Map<number, Set<number>>();
  for (const lane of lanes) {
    if (lane.tip !== null) {
      const chain = store.firstParentChain(lane.tip);
      chains.set(lane.lane, chain);
      chainSets.set(lane.lane, new Set(chain));
    }
  }

  for (const lane of lanes) {
    if (lane.tip === null || !chains.has(lane.lane)) continue;
    const chain = chains.get(lane.lane) as number[];
    const selfChainSet = chainSets.get(lane.lane) as Set<number>;

    // 规则 1：对每条"别的分支"，在本分支第一父链上找第一个交点。
    // 一旦找到就把这条别的分支从 pending 里摘掉，所以每条分支只留最早那次交点。
    const forks = new Map<number, { depth: number; commit: number; other: LaneInfo }>();
    let pending = lanes.filter((o) => o !== lane && o.tip !== null && chainSets.has(o.lane));
    for (let depth = 0; depth < chain.length; depth++) {
      if (!pending.length) break;
      const commit = chain[depth];
      const waiting: LaneInfo[] = [];
      for (const other of pending) {
        if ((chainSets.get(other.lane) as Set<number>).has(commit)) {
          forks.set(other.lane, { depth, commit, other });
        } else {
          waiting.push(other);
        }
      }
      pending = waiting;
    }

    const fixedLane = lane.kind === 'fixed';
    let pool = [...forks.values()];
    if (fixedLane) {
      // 规则 3：固定分支只可能从"排在它上面"的分支分出来
      pool = pool.filter((item) => item.other.lane < lane.lane);
    }

    // ⚠ 排序键逐字对齐 Python，且整体降序。改这里之前先看 test/regression.test.ts。
    const sortKey = (item: { depth: number; commit: number; other: LaneInfo }): number[] => [
      -item.depth,
      item.commit === item.other.tip ? 1 : 0,
      item.other.kind === 'fixed' ? 1 : 0,
      -item.other.lane,
    ];
    const ranked = pool.slice().sort((a, b) => -compareTuple(sortKey(a), sortKey(b)));

    let owner: LaneInfo | null = null;
    let anchor: number | null = null;
    let own = new Set<number>();

    for (const item of ranked) {
      const otherSet = chainSets.get(item.other.lane) as Set<number>;
      const work = fixedLane
        ? difference(selfChainSet, otherSet)
        : difference(lane.reach, ancestors(item.commit));
      if (!work.size) continue; // 规则 2 尾：own 为空的候选跳过
      owner = item.other;
      anchor = item.commit;
      own = work;
      break;
    }

    if (owner === null && !fixedLane) {
      // 没有共享的主线（独立的根），或者本分支自己没做出任何东西：
      // 退回到"接收了它合并结果"的那个分支。
      const targets = lanes
        .filter((o) => o !== lane && o.tip !== null)
        .sort((a, b) =>
          compareTuple(
            [isSuperset(a.reach, lane.reach) ? 0 : 1, a.reach.size, a.lane],
            [isSuperset(b.reach, lane.reach) ? 0 : 1, b.reach.size, b.lane],
          ),
        );
      for (const target of targets) {
        const merge = earliestMergeInto(store, target.reach, lane.reach);
        if (merge === null || !store.parents[merge].length) continue;
        const pivot = store.parents[merge][0];
        const work = difference(lane.reach, ancestors(pivot));
        if (work.size) {
          owner = target;
          anchor = pivot;
          own = work;
          break;
        }
      }
    }

    if (owner === null || anchor === null) {
      // 上面没东西了：这条就是层级的根
      lane.own = fixedLane ? new Set(chain) : new Set(lane.reach);
      continue;
    }

    lane.own = own;
    lane.parentName = owner.name;

    // fork = own 里最早那个提交的第一父，也就是"分出去时对方停在哪"
    let first = -1;
    let bestTs = Number.POSITIVE_INFINITY;
    for (const i of own) {
      const value = ts[i] || 0;
      if (value < bestTs) {
        bestTs = value;
        first = i;
      }
    }
    const parents = store.parents[first] ?? [];
    lane.fork = parents.length ? parents[0] : first;
  }
}

/** 历史上包含 `commit` 的、最"具体"的那条分支。 */
export function laneContaining(
  lanes: readonly LaneInfo[],
  commit: number,
  preferFixed = false,
): LaneInfo | null {
  const matches = lanes.filter((ln) => ln.reach.has(commit));
  if (!matches.length) return null;
  if (preferFixed) {
    const fixed = matches.filter((ln) => ln.kind === 'fixed');
    if (fixed.length) return minBy(fixed, (o) => [o.reach.size, o.lane]);
  }
  return minBy(matches, (o) => [o.reach.size, o.kind !== 'fixed' ? 1 : 0, o.lane]);
}

/** 一个合并提交该归给谁：最低的、包含它的那一层分支。 */
export function receivingLane(
  lanes: readonly LaneInfo[],
  tipToLane: Map<number, LaneInfo>,
  commit: number,
): LaneInfo | null {
  const direct = tipToLane.get(commit);
  if (direct !== undefined) return direct;
  return laneContaining(lanes, commit, true);
}

/** 开发分支如果一点自己的东西都不剩，就是已经完全合并了。 */
export function isMerged(lane: LaneInfo): boolean {
  return lane.kind !== 'fixed' && lane.own.size === 0;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 按字典序比较两个数值元组（Python 元组比较的等价物）。 */
export function compareTuple(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

export function minBy<T>(items: readonly T[], key: (item: T) => number[]): T {
  let best = items[0];
  let bestKey = key(best);
  for (let i = 1; i < items.length; i++) {
    const k = key(items[i]);
    if (compareTuple(k, bestKey) < 0) {
      best = items[i];
      bestKey = k;
    }
  }
  return best;
}

export function difference(a: ReadonlySet<number>, b: ReadonlySet<number>): Set<number> {
  const out = new Set<number>();
  for (const item of a) {
    if (!b.has(item)) out.add(item);
  }
  return out;
}

export function isSuperset(big: ReadonlySet<number>, small: ReadonlySet<number>): boolean {
  if (big.size < small.size) return false;
  for (const item of small) {
    if (!big.has(item)) return false;
  }
  return true;
}
