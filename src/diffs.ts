/**
 * 用 VS Code 原生的 diff 视图看某个版本改了什么。
 *
 * 网页版把 diff 塞在页面底部；这里交给 `vscode.diff`，好处是能直接享受
 * 编辑器的语法高亮、并排对比、以及"跳去改这个文件"之类的既有习惯。
 *
 * 内容通过一个自定义 scheme 的 TextDocumentContentProvider 提供——
 * `git show <sha>:<path>`，不需要把文件 checkout 出来。
 */

import * as vscode from 'vscode';
import { Git } from './git';

export const SCHEME = 'git-tree-commit';

/** 根提交没有父提交，用它当"空文件"的哨兵。 */
export const EMPTY_SHA = '0000000000000000000000000000000000000000';

interface Target {
  repo: string;
  sha: string;
  path: string;
  gitPath: string;
}

function uriFor(target: Target): vscode.Uri {
  return vscode.Uri.from({
    scheme: SCHEME,
    // path 只为了好看（标题栏显示文件名），真正的定位信息在 query 里
    path: '/' + target.path,
    query: JSON.stringify(target),
  });
}

export function registerContentProvider(): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
    provideTextDocumentContent(uri: vscode.Uri): string {
      let target: Target;
      try {
        target = JSON.parse(uri.query) as Target;
      } catch {
        return '';
      }
      if (target.sha === EMPTY_SHA) return '';
      const git = new Git(target.repo, target.gitPath);
      const res = git.tryRun(['show', `${target.sha}:${target.path}`], { timeoutMs: 60_000 });
      if (res.ok) return res.out;
      return `（读不出 ${target.sha.slice(0, 8)}:${target.path}）\n${res.out}`;
    },
  });
}

/** 第一父提交；根提交返回 null。 */
function firstParent(git: Git, sha: string): string | null {
  const res = git.tryRun(['rev-list', '--parents', '-n', '1', sha], { timeoutMs: 30_000 });
  if (!res.ok) return null;
  const parts = res.out.trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts[1] : null;
}

/**
 * 打开 `sha` 相对其第一父的改动。
 *
 * 用 `rev-list --parents` 现问一次而不是从 payload 的 `parents` 里翻：
 * 便宜，而且点老提交时 payload 里不一定还有那一行。
 */
export async function openCommitDiff(
  repoRoot: string,
  filePath: string,
  sha: string,
  gitPath: string,
): Promise<void> {
  const git = new Git(repoRoot, gitPath);
  const parent = firstParent(git, sha);
  const left = uriFor({ repo: repoRoot, sha: parent ?? EMPTY_SHA, path: filePath, gitPath });
  const right = uriFor({ repo: repoRoot, sha, path: filePath, gitPath });
  const title = `${filePath.split('/').pop() ?? filePath} (${parent ? parent.slice(0, 8) : '空'} ↔ ${sha.slice(0, 8)})`;
  await vscode.commands.executeCommand('vscode.diff', left, right, title);
}
