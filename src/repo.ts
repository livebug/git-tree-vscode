/**
 * 仓库句柄：分支引用、tag、单文件历史，以及缓存。
 *
 * 对齐 git-tree/backend/repo.py 的 `Repository`，只保留单文件版本树需要的那部分
 * （分支图那套 build_branch_graph 本项目不做）。
 */

import { FLD, Git } from './git';
import { CommitStore, DEFAULT_MAX_COMMITS } from './gitstore';

export interface RefInfo {
  name: string;
  sha: string;
  ts: number;
  subject: string;
  remote: boolean;
}

export interface TagInfo {
  /** 短名，例如 `LBL_BASE`。 */
  name: string;
  /** tagged commit（annotated tag 已剥离）。 */
  sha: string;
  annotated: boolean;
}

export interface ChangeInfo {
  status: string;
  path: string;
}

export interface FileRecord {
  sha: string;
  parents: string[];
  ts: number;
  author: string;
  subject: string;
  changes: ChangeInfo[];
}

export interface RepoInfo {
  path: string;
  name: string;
  head: string | null;
  bare: boolean;
  branchCount: number;
}

/**
 * 看哪些分支：只看本地、只看远端，还是都看。
 *
 * `remote` 是给"我只关心远端仓库上有什么"准备的——本地可能只是一个陈旧的镜像。
 */
export type BranchScope = 'local' | 'remote' | 'all';

/** `origin/dev` → `dev`；不带 `/` 的名字原样返回。 */
export function branchPart(name: string): string {
  const cut = name.indexOf('/');
  return cut < 0 ? name : name.slice(cut + 1);
}

/**
 * 按范围挑 refs。
 *
 * `all` 会去掉"远端的本地镜像"：本地有 `dev`、远端也有 `origin/dev` 时只留一份，
 * 否则同一条分支会画成两根并排的轨道，反而更难读。远端独有的分支（本地不存在同名分支）
 * 仍然会出现。
 */
export function selectRefs(refs: readonly RefInfo[], scope: BranchScope): RefInfo[] {
  if (scope === 'local') return refs.filter((r) => !r.remote);
  if (scope === 'remote') return refs.filter((r) => r.remote);
  const localNames = new Set(refs.filter((r) => !r.remote).map((r) => r.name));
  const out = refs.filter((r) => !r.remote);
  for (const ref of refs) {
    if (!ref.remote) continue;
    const part = branchPart(ref.name);
    if (part && localNames.has(part)) continue;
    out.push(ref);
  }
  return out;
}

/** 习惯上算"长期分支"的名字——只用来做默认建议。 */
export const DEFAULT_FIXED = [
  'master',
  'main',
  'dev',
  'develop',
  'uat',
  'release',
  'prod',
  'production',
  'test',
];

/** `owner/repo-1a2b3c4d5e6f` 这种克隆缓存目录名要还原成人类可读的名字。 */
const CACHE_SUFFIX_RE = /-[0-9a-f]{12}$/;

function displayName(path: string): string {
  let candidate = path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? '';
  if (candidate.endsWith('.git')) candidate = candidate.slice(0, -4);
  candidate = candidate.replace(CACHE_SUFFIX_RE, '');
  return candidate || 'repo';
}

export interface RepoHandleOptions {
  gitPath?: string;
  maxCommits?: number;
}

export class RepoHandle {
  readonly git: Git;
  readonly path: string;

  private storeValue: CommitStore | null = null;
  private refsValue: RefInfo[] | null = null;
  private tagsValue: TagInfo[] | null = null;
  private readonly reachCache = new Map<number, Set<number>>();
  private readonly fileHistoryCache = new Map<string, FileRecord[]>();
  private infoValue: RepoInfo | null = null;

  constructor(
    path: string,
    private readonly options: RepoHandleOptions = {},
  ) {
    this.path = path;
    this.git = new Git(path, options.gitPath ?? 'git');
  }

  /** 丢掉所有缓存。`git fetch` 之类改动 refs 的操作之后必须调。 */
  invalidate(): void {
    this.storeValue = null;
    this.refsValue = null;
    this.tagsValue = null;
    this.reachCache.clear();
    this.fileHistoryCache.clear();
    this.infoValue = null;
  }

  /**
   * refs 指纹：用来判断仓库有没有变过。
   *
   * 不能只看提交总数——amend / rebase / force push 之后总数可能一模一样，
   * 那样子会一直显示一份过期的缓存。
   *
   * 这里**故意绕过自己的缓存**：如果走 `refs()`，拿到的是上次的快照，
   * 那就永远测不出变化了。
   */
  fingerprint(): string {
    const fmt = `%(refname)${FLD}%(objectname)`;
    const res = this.git.tryRun(
      [
        'for-each-ref',
        `--format=${fmt}`,
        'refs/heads',
        'refs/remotes',
        'refs/tags',
      ],
      { timeoutMs: 60_000 },
    );
    if (!res.ok) return '';
    return res.out.split('\n').filter(Boolean).sort().join(',');
  }

  // -- 数据 ----------------------------------------------------------

  store(): CommitStore {
    if (this.storeValue === null) {
      const store = new CommitStore(this.options.maxCommits ?? DEFAULT_MAX_COMMITS);
      store.load(this.git);
      this.storeValue = store;
    }
    return this.storeValue;
  }

  refs(): RefInfo[] {
    if (this.refsValue !== null) return this.refsValue;

    const fmt = [
      '%(refname)',
      '%(objectname)',
      '%(committerdate:unix)',
      '%(contents:subject)',
      '%(objecttype)',
      '%(symref)',
    ].join(FLD);
    const res = this.git.tryRun(
      ['for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes'],
      { timeoutMs: 120_000 },
    );

    const refs: RefInfo[] = [];
    if (res.ok) {
      for (const line of res.out.split('\n')) {
        if (!line) continue;
        const parts = line.split(FLD);
        if (parts.length < 6) continue;
        const [refname, sha, tsRaw, subject, objtype, symref] = parts;
        // 指向 tag/树的引用、以及符号引用（origin/HEAD 之类）都跳过
        if (objtype !== 'commit' || symref) continue;
        let name: string;
        let remote: boolean;
        if (refname.startsWith('refs/heads/')) {
          name = refname.slice('refs/heads/'.length);
          remote = false;
        } else if (refname.startsWith('refs/remotes/')) {
          name = refname.slice('refs/remotes/'.length);
          if (name.endsWith('/HEAD')) continue;
          remote = true;
        } else {
          continue;
        }
        const ts = Number.parseInt(tsRaw, 10);
        refs.push({ name, sha, ts: Number.isNaN(ts) ? 0 : ts, subject, remote });
      }
    }
    this.refsValue = refs;
    return refs;
  }

  /**
   * tag 及其指向的提交（annotated tag 会剥离一层）。
   *
   * 这里扮演的是 ClearCase 的 label——版本树上的琥珀色小标签。
   */
  tags(): TagInfo[] {
    if (this.tagsValue !== null) return this.tagsValue;

    const fmt = ['%(refname:short)', '%(objectname)', '%(*objectname)', '%(objecttype)'].join(FLD);
    const res = this.git.tryRun(['for-each-ref', `--format=${fmt}`, 'refs/tags'], {
      timeoutMs: 60_000,
    });

    const tags: TagInfo[] = [];
    if (res.ok) {
      for (const line of res.out.split('\n')) {
        if (!line) continue;
        const parts = line.split(FLD);
        if (parts.length < 4) continue;
        const [name, obj, peeled, objtype] = parts;
        if (!name) continue;
        tags.push({ name, sha: peeled || obj, annotated: Boolean(peeled) || objtype === 'tag' });
      }
    }
    tags.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    this.tagsValue = tags;
    return tags;
  }

  reachForTip(tip: number): Set<number> {
    let cached = this.reachCache.get(tip);
    if (cached === undefined) {
      cached = this.store().ancestors(tip);
      this.reachCache.set(tip, cached);
    }
    return cached;
  }

  /**
   * 预热，给扩展宿主用。
   *
   * 慢的两条 git 命令（`log --all`、`log --name-status`）先异步跑完并填进缓存，
   * 之后 `buildFileGraph()` 还是同步的，但它要的数据已经在内存里了——
   * 这样既不会卡住共享的扩展宿主进程，也不用把整个算法改成 async。
   */
  async prefetch(filePath: string, limit = 4000, follow = false): Promise<void> {
    if (this.storeValue === null) {
      const store = new CommitStore(this.options.maxCommits ?? DEFAULT_MAX_COMMITS);
      await store.loadAsync(this.git);
      this.storeValue = store;
    }
    await this.fileHistoryAsync(filePath, limit, follow);
  }

  /**
   * 改动过 `path` 的提交，跨所有 ref。
   *
   * `follow` 时退化成 `--follow`（它只在单条线性历史上有效，所以不能再带 `--all`）。
   */
  fileHistory(filePath: string, limit = 4000, follow = false): FileRecord[] {
    const key = historyKey(filePath, limit, follow);
    const cached = this.fileHistoryCache.get(key);
    if (cached) return cached;
    const res = this.git.tryRun(historyArgs(filePath, limit, follow), { timeoutMs: 300_000 });
    const records = res.ok ? parseFileHistory(res.out) : [];
    this.fileHistoryCache.set(key, records);
    return records;
  }

  /** 同上，但不阻塞扩展宿主。 */
  async fileHistoryAsync(filePath: string, limit = 4000, follow = false): Promise<FileRecord[]> {
    const key = historyKey(filePath, limit, follow);
    const cached = this.fileHistoryCache.get(key);
    if (cached) return cached;
    let out = '';
    try {
      out = await this.git.runAsync(historyArgs(filePath, limit, follow), { timeoutMs: 300_000 });
    } catch {
      out = '';
    }
    const records = parseFileHistory(out);
    this.fileHistoryCache.set(key, records);
    return records;
  }

  info(): RepoInfo {
    if (this.infoValue !== null) return this.infoValue;
    const refs = this.refs();
    const head = this.git.headBranch();
    this.infoValue = {
      path: this.path,
      name: displayName(this.path),
      head,
      bare: this.git.isBare(),
      branchCount: refs.filter((r) => !r.remote).length,
    };
    return this.infoValue;
  }
}

// ---------------------------------------------------------------------------
// 单文件历史的命令构造 / 解析（同步、异步两条路共用）
// ---------------------------------------------------------------------------

function historyKey(filePath: string, limit: number, follow: boolean): string {
  return `${limit}|${follow ? 'follow' : 'all'}|${filePath}`;
}

function historyArgs(filePath: string, limit: number, follow: boolean): string[] {
  const fmt = '\x1e' + ['%H', '%P', '%ct', '%cn', '%s'].join(FLD) + '\n';
  const args = follow
    ? ['log', `--max-count=${limit}`, '--name-status', `--format=${fmt}`, '--follow']
    : ['log', '--all', `--max-count=${limit}`, '--name-status', '--no-renames', `--format=${fmt}`];
  args.push('--', filePath);
  return args;
}

function parseFileHistory(out: string): FileRecord[] {
  const records: FileRecord[] = [];
  for (const chunk of out.split('\x1e')) {
    if (!chunk.trim()) continue;
    const lines = chunk.split('\n').filter((ln) => ln.trim());
    if (!lines.length) continue;
    const parts = lines[0].split(FLD);
    if (parts.length < 5) continue;

    const changes: ChangeInfo[] = [];
    for (const ln of lines.slice(1)) {
      const bits = ln.split('\t');
      if (bits.length >= 3) changes.push({ status: bits[0], path: bits[2] });
      else if (bits.length === 2) changes.push({ status: bits[0], path: bits[1] });
    }
    const ts = Number.parseInt(parts[2], 10);
    records.push({
      sha: parts[0],
      parents: parts[1] ? parts[1].split(/\s+/).filter(Boolean) : [],
      ts: Number.isNaN(ts) ? 0 : ts,
      author: parts[3],
      subject: parts[4],
      changes,
    });
  }
  return records;
}
