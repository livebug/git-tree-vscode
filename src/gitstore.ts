/**
 * 提交 DAG：用稠密整数下标索引的平行数组。
 *
 * 移植自 git-tree/backend/repo.py 的 `CommitStore`（那里的 @dataclass 风格
 * 平行数组在这里对应一组 number[] / string[]）。逐个方法对齐语义，包括
 * `truncated` 的判定方式——它决定要不要给出"历史被截断"的警告。
 */

import { FLD, Git, REC } from './git';

export const DEFAULT_MAX_COMMITS = 40000;

interface RawCommit {
  sha: string;
  parents: string[];
  ts: number;
  author: string;
  subject: string;
}

export class CommitStore {
  sha: string[] = [];
  parents: number[][] = [];
  ts: number[] = [];
  author: string[] = [];
  subject: string[] = [];
  index = new Map<string, number>();
  children: number[][] = [];
  mergeIds: number[] = [];
  /** 历史被 `limit` 截断，或有父提交不在窗口内 —— 两种都会让归属判断打折扣。 */
  truncated = false;
  loaded = false;

  constructor(readonly limit: number = DEFAULT_MAX_COMMITS) {}

  // -- 加载 ----------------------------------------------------------

  load(git: Git): void {
    let out = '';
    try {
      out = git.run(logArgs(this.limit));
    } catch {
      // 空仓库（还没有提交）或历史完全读不出来：当作 0 个提交，不炸。
      out = '';
    }
    this.build(parseLog(out));
    this.loaded = true;
  }

  /** 异步版本。扩展宿主里跑这个，别把共享的宿主进程卡住。 */
  async loadAsync(git: Git): Promise<void> {
    let out = '';
    try {
      out = await git.runAsync(logArgs(this.limit));
    } catch {
      out = '';
    }
    this.build(parseLog(out));
    this.loaded = true;
  }

  private build(raw: RawCommit[]): void {
    this.sha = [];
    this.parents = [];
    this.ts = [];
    this.author = [];
    this.subject = [];
    this.index = new Map();

    for (const item of raw) {
      const idx = this.sha.length;
      this.index.set(item.sha, idx);
      this.sha.push(item.sha);
      this.ts.push(item.ts);
      this.author.push(item.author);
      this.subject.push(item.subject);
      this.parents.push([]);
    }

    let missing = 0;
    for (let i = 0; i < raw.length; i++) {
      const resolved: number[] = [];
      for (const p of raw[i].parents) {
        const j = this.index.get(p);
        if (j === undefined) missing++;
        else resolved.push(j);
      }
      this.parents[i] = resolved;
    }
    if (missing) this.truncated = true;
    if (raw.length >= this.limit) this.truncated = true;

    this.children = this.sha.map(() => [] as number[]);
    for (let i = 0; i < this.parents.length; i++) {
      for (const p of this.parents[i]) this.children[p].push(i);
    }
    this.mergeIds = [];
    for (let i = 0; i < this.parents.length; i++) {
      if (this.parents[i].length > 1) this.mergeIds.push(i);
    }
  }

  // -- 查询 ----------------------------------------------------------

  get(shaOrRev: string): number | undefined {
    return this.index.get(shaOrRev);
  }

  /** `start` 自身 + 全部祖先。 */
  ancestors(start: number): Set<number> {
    const seen = new Set<number>([start]);
    const stack = [start];
    while (stack.length) {
      const i = stack.pop() as number;
      for (const p of this.parents[i]) {
        if (!seen.has(p)) {
          seen.add(p);
          stack.push(p);
        }
      }
    }
    return seen;
  }

  /** `start` 自身 + 全部后代。 */
  forward(start: number): Set<number> {
    const seen = new Set<number>([start]);
    const stack = [start];
    while (stack.length) {
      const i = stack.pop() as number;
      for (const c of this.children[i]) {
        if (!seen.has(c)) {
          seen.add(c);
          stack.push(c);
        }
      }
    }
    return seen;
  }

  /**
   * 从 `start` 沿第一父链往根走。
   *
   * 这是整个工具的地基：**分叉点**就是在两条分支的第一父链上找分歧，
   * 而不是找"最近的共同祖先"（见 lineage.ts 的说明）。
   */
  firstParentChain(start: number): number[] {
    const chain = [start];
    const seen = new Set<number>([start]);
    let cur = start;
    for (;;) {
      const parents = this.parents[cur];
      if (!parents.length) break;
      const next = parents[0];
      if (seen.has(next)) break;
      seen.add(next);
      chain.push(next);
      cur = next;
    }
    return chain;
  }

  short(i: number): string {
    return this.sha[i].slice(0, 8);
  }
}

/** 加载整个 DAG 用的 git 参数（同步/异步两条路共用一份）。 */
function logArgs(limit: number): string[] {
  const fmt = ['%H', '%P', '%ct', '%cn', '%s'].join(FLD) + REC;
  return ['log', '--all', `--max-count=${limit}`, '--date-order', `--format=${fmt}`];
}

/**
 * 解析 `git log --format=%H%x1f%P%x1f%ct%x1f%cn%x1f%s%x1e` 的输出。
 *
 * 注意 `%s` 本身不会带换行，但每条记录后面跟着 REC，所以按 REC 切开之后
 * 每块的第一行就是字段行。多余字段（理论上不该有）丢弃，与 Python 侧一致。
 */
function parseLog(out: string): RawCommit[] {
  const raw: RawCommit[] = [];
  for (const chunk of out.split(REC)) {
    const body = chunk.replace(/^\n+/, '').replace(/\n+$/, '');
    if (!body) continue;
    const head = body.split('\n')[0];
    const parts = head.split(FLD);
    if (parts.length < 5) continue;
    const ts = Number.parseInt(parts[2], 10);
    raw.push({
      sha: parts[0],
      parents: parts[1] ? parts[1].split(/\s+/).filter(Boolean) : [],
      ts: Number.isNaN(ts) ? 0 : ts,
      author: parts[3],
      subject: parts[4],
    });
  }
  return raw;
}
