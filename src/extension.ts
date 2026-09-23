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
import { BranchScope, RepoHandle, selectRefs } from './repo';

/** `git log --name-status -- <path>` 的上限。单文件历史一般远小于整个 DAG。 */
const FILE_HISTORY_LIMIT = 4000;

/**
 * 面板里改过的开关，记在会话里。
 *
 * 每次右键打开都用设置里的初始值会很烦：用户刚切成“远程”，换个文件看又回去了。
 */
let sessionScope: BranchScope | null = null;
let sessionFollow: boolean | null = null;

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

  const state: PanelState = {
    repoRoot,
    filePath,
    follow: sessionFollow ?? cfg.follow,
    scope: sessionScope ?? cfg.branchScope,
  };

  const host: PanelHost = {
    load: (s) => loadPayload(s),
    invalidate: (s) => invalidateRepo(s),
    openDiff: (sha, s) => openCommitDiff(s.repoRoot, s.filePath, sha, cfg.gitPath),
    remember: (prefs) => {
      if (prefs.scope !== undefined) sessionScope = prefs.scope;
      if (prefs.follow !== undefined) sessionFollow = prefs.follow;
    },
    toast: (text) => {
      void vscode.window.setStatusBarMessage(text, 4000);
    },
  };

  VersionTreePanel.reveal(context.extensionUri, host, state);
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

  const payload = buildFileGraph(handle, state.filePath, fixed, {
    scope: state.scope,
    follow: state.follow,
    maxCommits: FILE_HISTORY_LIMIT,
  });

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
