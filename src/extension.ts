/**
 * 扩展入口：右键文件 → 查看版本树。
 *
 * 数据全部由本扩展自己算（TS 直接调 git），**不依赖 Python、也不依赖 git-tree
 * 那个网页版**。见 CONTRACT.md 与 src/filegraph.ts。
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { openCommitDiff, registerContentProvider } from './diffs';
import { resolveFixed } from './fixed';
import { FileGraphPayload, buildFileGraph } from './filegraph';
import { Git } from './git';
import { PanelHost, PanelState, VersionTreePanel } from './panel';
import {
  BranchScope,
  RepoHandle,
  branchPart,
  defaultBranchSelection,
  matchBranchPatterns,
  selectRefs,
} from './repo';

/** `git log --name-status -- <path>` 的上限。单文件历史一般远小于整个 DAG。 */
const FILE_HISTORY_LIMIT = 4000;

/**
 * 面板里改过的开关，记在会话里。
 *
 * 每次右键打开都用设置里的初始值会很烦：用户刚切成“远程”，换个文件看又回去了。
 */
let sessionScope: BranchScope | null = null;
let sessionFollow: boolean | null = null;
let sessionShowTags: boolean | null = null;
/** `undefined` = 还没动过（用配置默认）；`null` = 用户选了“全部分支”。 */
let sessionBranches: string[] | null | undefined;

interface CacheEntry {
  handle: RepoHandle;
  /** 上次看到的 refs 指纹；用来发现仓库被 amend / rebase / fetch 过。 */
  fingerprint: string;
}

const repoCache = new Map<string, CacheEntry>();

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(registerContentProvider());
  context.subscriptions.push(
    vscode.commands.registerCommand('gitTree.showVersionTree', (uri?: vscode.Uri) =>
      showVersionTree(context, uri),
    ),
  );
}

export function deactivate(): void {
  repoCache.clear();
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

async function showVersionTree(
  context: vscode.ExtensionContext,
  uri?: vscode.Uri,
): Promise<void> {
  const target = await resolveTargetUri(uri);
  if (!target) return;

  const cfg = readSettings();
  const folder = path.dirname(target.fsPath);
  const probe = new Git(folder, cfg.gitPath);

  if (!probe.isRepo()) {
    void vscode.window.showWarningMessage(
      `git-tree：${folder} 不在 git 仓库里（确认 git 已安装、且这个目录属于某个仓库）。`,
    );
    return;
  }

  const repoRoot = probe.topLevel();
  if (!repoRoot) {
    void vscode.window.showWarningMessage(
      'git-tree：这是一个裸仓库，没有工作区，无法把文件路径对应到提交内容。',
    );
    return;
  }

  const filePath = path.relative(repoRoot, target.fsPath).split(path.sep).join('/');
  if (!filePath || filePath.startsWith('..')) {
    void vscode.window.showWarningMessage('git-tree：这个文件不在仓库工作区内。');
    return;
  }

  const scope = sessionScope ?? cfg.branchScope;
  const branches =
    sessionBranches !== undefined ? sessionBranches : defaultBranches(repoRoot, cfg, scope);

  const state: PanelState = {
    repoRoot,
    filePath,
    follow: sessionFollow ?? cfg.follow,
    scope,
    showTags: sessionShowTags ?? cfg.showTags,
    branches,
  };

  const host: PanelHost = {
    load: (s) => loadPayload(s),
    invalidate: (s) => invalidateRepo(s),
    openDiff: (sha, s) => openCommitDiff(s.repoRoot, s.filePath, sha, cfg.gitPath),
    pickBranches: (s) => pickBranches(s),
    remember: (prefs) => {
      if (prefs.scope !== undefined) sessionScope = prefs.scope;
      if (prefs.follow !== undefined) sessionFollow = prefs.follow;
      if (prefs.showTags !== undefined) sessionShowTags = prefs.showTags;
      if (prefs.branches !== undefined) sessionBranches = prefs.branches;
    },
    toast: (text) => {
      void vscode.window.setStatusBarMessage(text, 4000);
    },
  };

  VersionTreePanel.reveal(context.extensionUri, host, state);
}

// ---------------------------------------------------------------------------
// 分支筛选
// ---------------------------------------------------------------------------

interface BranchPickItem extends vscode.QuickPickItem {
  action: 'all' | 'branch';
}

/** 打开面板时的默认筛选：配置 glob > 固定分支 > 全部（null）。 */
function defaultBranches(
  repoRoot: string,
  cfg: Settings,
  scope: BranchScope,
): string[] | null {
  const handle = handleFor(repoRoot, cfg.gitPath, cfg.maxCommits);
  const refs = handle.refs();
  if (!refs.length) return null;
  const fixed = resolveFixed(cfg.fixedBranches, refs, handle.info().head, {
    prefixes: cfg.fixedPrefixes,
    auto: cfg.autoFixed,
    scope,
  }).fixed;
  const fixedShort = [...new Set(fixed.map(branchPart))];
  return defaultBranchSelection(selectRefs(refs, scope), fixedShort, cfg.branchFilter).branches;
}

/**
 * 面板里点「分支」时弹的多选列表。
 *
 * 固定分支排前面、默认勾上；顶部一条「显示全部分支」用来清空筛选。
 * 返回 `null` 表示不筛（全部），`canceled` 表示用户按了 Esc。
 */
async function pickBranches(
  state: PanelState,
): Promise<{ canceled: boolean; branches: string[] | null }> {
  const cfg = readSettings();
  const handle = handleFor(state.repoRoot, cfg.gitPath, cfg.maxCommits);
  const refs = selectRefs(handle.refs(), state.scope);
  if (!refs.length) {
    void vscode.window.showWarningMessage('git-tree：这个范围里没有分支可选。');
    return { canceled: true, branches: state.branches };
  }

  const fixed = resolveFixed(cfg.fixedBranches, handle.refs(), handle.info().head, {
    prefixes: cfg.fixedPrefixes,
    auto: cfg.autoFixed,
    scope: state.scope,
  }).fixed;
  const fixedSet = new Set(fixed.map(branchPart));
  const ordered = [...refs].sort((a, b) => {
    const fa = fixedSet.has(branchPart(a.name)) ? 0 : 1;
    const fb = fixedSet.has(branchPart(b.name)) ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  const selected = state.branches === null ? null : new Set(state.branches);
  const items: BranchPickItem[] = [
    {
      label: '$(list-unordered) 显示全部分支',
      description: '清空筛选',
      action: 'all',
      alwaysShow: true,
    },
    ...ordered.map((ref) => ({
      label: ref.name,
      description: ref.remote ? '远端' : '',
      detail: ref.subject,
      picked: selected === null || selected.has(branchPart(ref.name)),
      action: 'branch' as const,
    })),
  ];

  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: '看哪些分支',
    placeHolder: '勾选要显示的轨道（固定分支建议保留），Esc 取消',
    matchOnDetail: true,
  });
  if (!picked) return { canceled: true, branches: state.branches };
  if (picked.some((item) => item.action === 'all')) {
    return { canceled: false, branches: null };
  }

  const names = [...new Set(picked.map((item) => branchPart(item.label)))];
  if (!names.length) {
    void vscode.window.showInformationMessage('git-tree：至少选一个分支。');
    return { canceled: true, branches: state.branches };
  }
  // 全勾 == 不筛，方便下次新增分支时自动出现
  if (names.length >= new Set(refs.map((ref) => branchPart(ref.name))).size) {
    return { canceled: false, branches: null };
  }
  return { canceled: false, branches: names };
}

/** 资源管理器右键传进来的是 uri；命令面板则没有参数，退回当前编辑器。 */
async function resolveTargetUri(uri?: vscode.Uri): Promise<vscode.Uri | null> {
  if (uri && uri.scheme === 'file') return uri;
  const active = vscode.window.activeTextEditor;
  if (active && active.document.uri.scheme === 'file') {
    // 只对磁盘上的文件有意义：未保存的 untitled 文档没有仓库归属
    if (active.document.isUntitled) return null;
    return active.document.uri;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    canSelectFiles: true,
    canSelectFolders: false,
    openLabel: '查看版本树',
  });
  return picked && picked.length ? picked[0] : null;
}

// ---------------------------------------------------------------------------
// 取数
// ---------------------------------------------------------------------------

async function loadPayload(state: PanelState): Promise<FileGraphPayload> {
  const cfg = readSettings();
  const handle = handleFor(state.repoRoot, cfg.gitPath, cfg.maxCommits);
  syncHandle(state.repoRoot, cfg.gitPath, cfg.maxCommits, handle);

  // 慢的两条命令先异步跑完，之后 buildFileGraph 是纯内存计算——
  // 既不卡住扩展宿主，也不用把算法改成 async。
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `git-tree：读取 ${state.filePath} 的历史…`,
    },
    () => handle.prefetch(state.filePath, FILE_HISTORY_LIMIT, state.follow),
  );

  const info = handle.info();
  const { fixed, source } = resolveFixed(cfg.fixedBranches, handle.refs(), info.head, {
    prefixes: cfg.fixedPrefixes,
    auto: cfg.autoFixed,
    scope: state.scope,
  });

  const scopedRefs = selectRefs(handle.refs(), state.scope);
  // 会话里记着的分支可能已经被删了 / 改成远端了：别让图静默变空
  let branches = state.branches;
  let branchFallback = false;
  if (branches && branches.length) {
    const hit = scopedRefs.some(
      (ref) => branches!.includes(ref.name) || branches!.includes(branchPart(ref.name)),
    );
    if (!hit) {
      branches = null;
      branchFallback = true;
    }
  }

  let payload = buildFileGraph(handle, state.filePath, fixed, {
    scope: state.scope,
    follow: state.follow,
    maxCommits: FILE_HISTORY_LIMIT,
    branches,
  });

  // 筛选把包含这个文件的分支全筛掉了（比如文件只在 fb-* 上改过）：临时退回去，
  // 不然用户看到的是空图，还以为文件没有历史。
  if (branches && branches.length && !payload.lanes.length && payload.commits.length) {
    payload = buildFileGraph(handle, state.filePath, fixed, {
      scope: state.scope,
      follow: state.follow,
      maxCommits: FILE_HISTORY_LIMIT,
    });
    payload.warnings.push('这个文件不在选中的分支上，已临时显示包含它的分支。');
  }

  if (branchFallback) {
    payload.warnings.push('筛选的分支在这个范围里都不存在了，已恢复显示全部分支。');
  }
  // 配了 branchFilter 却一条都没匹配上：说一声，别让人以为配置生效了
  if (
    sessionBranches === undefined &&
    cfg.branchFilter.length &&
    !matchBranchPatterns(scopedRefs, cfg.branchFilter).length
  ) {
    payload.warnings.push(
      `gitTree.branchFilter（${cfg.branchFilter.join(', ')}）没有匹配到任何分支，已按默认显示。`,
    );
  }

  // 只看远程时，本地没 fetch 过就真的一条分支都没有——这个坑要说出来
  if (state.scope !== 'local' && !selectRefs(handle.refs(), state.scope).length) {
    payload.warnings.push(
      state.scope === 'remote'
        ? '这个仓库里没有远端分支（先 git fetch 再看）。'
        : '没有可用的分支。',
    );
  }

  // 固定分支缺失是这套图**最常见的坏结果**：没有它就没有"承载轨道"，
  // 改动往上传播的路径整片消失。所以这里必须说出来，别让用户以为这文件就这么简单。
  if (!fixed.length) {
    payload.warnings.push(
      '没有识别出固定分支，改动往上传播的路径不会显示。可用设置 gitTree.fixedBranches 指定发布层级。',
    );
  } else if (source === 'auto') {
    payload.warnings.push(
      `固定分支是自动识别的（${fixed.join(' → ')}）；不对的话请设置 gitTree.fixedBranches。`,
    );
  }

  if (handle.store().truncated) {
    payload.warnings.push(
      `历史被 gitTree.maxCommits（${cfg.maxCommits}）截断，部分提交的归属判断可能不完整。`,
    );
  }

  return payload;
}

function handleFor(repoRoot: string, gitPath: string, maxCommits: number): RepoHandle {
  const key = cacheKey(repoRoot, gitPath, maxCommits);
  const cached = repoCache.get(key);
  if (cached) return cached.handle;
  const handle = new RepoHandle(repoRoot, { gitPath, maxCommits });
  repoCache.set(key, { handle, fingerprint: '' });
  return handle;
}

/**
 * 仓库被别人 amend / rebase / fetch 过就丢掉缓存。
 *
 * 判据是 refs 指纹而不是提交数量：rebase 之后提交总数可能一模一样，
 * 只看数量会一直显示一份过期的图。
 */
function syncHandle(
  repoRoot: string,
  gitPath: string,
  maxCommits: number,
  handle: RepoHandle,
): void {
  const entry = repoCache.get(cacheKey(repoRoot, gitPath, maxCommits));
  if (!entry) return;
  const fingerprint = handle.fingerprint();
  if (!entry.fingerprint) {
    entry.fingerprint = fingerprint;
    return;
  }
  if (entry.fingerprint !== fingerprint) {
    handle.invalidate();
    entry.fingerprint = fingerprint;
  }
}

function invalidateRepo(state: PanelState): void {
  const prefix = state.repoRoot + '|';
  for (const [key, entry] of repoCache) {
    if (!key.startsWith(prefix)) continue;
    entry.handle.invalidate();
    entry.fingerprint = '';
  }
}

function cacheKey(repoRoot: string, gitPath: string, maxCommits: number): string {
  return `${repoRoot}|${gitPath}|${maxCommits}`;
}

interface Settings {
  fixedBranches: string[];
  autoFixed: boolean;
  fixedPrefixes: string[];
  maxCommits: number;
  branchScope: BranchScope;
  follow: boolean;
  showTags: boolean;
  /** 默认只看哪些分支（glob，空 = 只看固定分支）。 */
  branchFilter: string[];
  gitPath: string;
}

function readSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration('gitTree');
  return {
    fixedBranches: cfg.get<string[]>('fixedBranches') ?? [],
    autoFixed: cfg.get<boolean>('autoFixed') ?? true,
    fixedPrefixes: cfg.get<string[]>('fixedPrefixes') ?? [],
    maxCommits: cfg.get<number>('maxCommits') ?? 40000,
    branchScope: readScope(cfg),
    follow: cfg.get<boolean>('follow') ?? false,
    showTags: cfg.get<boolean>('showTags') ?? false,
    branchFilter: (cfg.get<string[]>('branchFilter') ?? []).filter(
      (p): p is string => typeof p === 'string' && p.trim().length > 0,
    ),
    gitPath: cfg.get<string>('gitPath') || 'git',
  };
}

/**
 * 分支范围。
 *
 * `gitTree.includeRemotes` 是旧设置项，留着兼容：它还开着（而且没显式改过 branchScope）
 * 就等于 `all`，免得升级之后别人发现远端分支“不见了”。
 */
function readScope(cfg: vscode.WorkspaceConfiguration): BranchScope {
  const value = cfg.get<string>('branchScope') ?? 'local';
  const scope: BranchScope =
    value === 'remote' || value === 'all' ? value : 'local';
  if (scope === 'local' && (cfg.get<boolean>('includeRemotes') ?? false)) return 'all';
  return scope;
}
