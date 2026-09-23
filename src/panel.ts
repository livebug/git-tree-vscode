/**
 * 版本树面板（webview）。
 *
 * 渲染完全交给 media/graph.js（从 git-tree 拷来的那份，见文件头的来源说明），
 * 这里只负责：CSP、主题、收发消息、以及"复用同一个面板"。
 *
 * 复用是有意的：从资源管理器连着右键好几个文件，不应该开出一排标签页。
 */

import * as vscode from 'vscode';
import { FileGraphPayload } from './filegraph';
import { BranchScope } from './repo';

export interface PanelState {
  /** 仓库根目录（绝对路径）。 */
  repoRoot: string;
  /** 仓库相对路径，'/' 分隔。 */
  filePath: string;
  follow: boolean;
  /** 看哪些分支：本地 / 远端 / 全部。 */
  scope: BranchScope;
}

export interface PanelHost {
  /** 取一份数据。里面的慢命令应该已经预热过，见 RepoHandle.prefetch。 */
  load(state: PanelState): Promise<FileGraphPayload>;
  /** 丢掉这个仓库的缓存（用户点了「刷新」）。 */
  invalidate(state: PanelState): void;
  openDiff(sha: string, state: PanelState): Promise<void>;
  /** 把面板里改的开关记在本会话里，下次打开还是这个值。 */
  remember(prefs: { scope?: BranchScope; follow?: boolean }): void;
  toast(text: string): void;
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export class VersionTreePanel {
  private static current: VersionTreePanel | null = null;
  private static readonly viewType = 'gitTreeVersionTree';

  private readonly disposables: vscode.Disposable[] = [];
  /** webview 的脚本还没跑起来之前发消息会丢，所以等它先说 ready。 */
  private ready = false;
  private queued = false;
  private reloading = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly host: PanelHost,
    private state: PanelState,
  ) {
    this.panel.webview.html = this.renderHtml();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message) => void this.onMessage(message),
      null,
      this.disposables,
    );
  }

  static reveal(
    extensionUri: vscode.Uri,
    host: PanelHost,
    state: PanelState,
  ): VersionTreePanel {
    const existing = VersionTreePanel.current;
    if (existing) {
      existing.state = state;
      existing.panel.title = `版本树 · ${state.filePath}`;
      existing.panel.reveal(vscode.ViewColumn.Beside, true);
      existing.requestReload();
      return existing;
    }

    const panel = vscode.window.createWebviewPanel(
      VersionTreePanel.viewType,
      `版本树 · ${state.filePath}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        // 只开放 media/，图省事也别把整个扩展目录暴露给 webview
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      },
    );
    const instance = new VersionTreePanel(panel, extensionUri, host, state);
    VersionTreePanel.current = instance;
    return instance;
  }

  /** 当前面板里正在看的文件（测试/调试用）。 */
  get currentState(): PanelState {
    return this.state;
  }

  private requestReload(): void {
    this.queued = true;
    if (!this.ready || this.reloading) return;
    this.queued = false;
    void this.reload();
  }

  private async reload(): Promise<void> {
    this.reloading = true;
    await this.post({ type: 'busy', value: true });
    try {
      const payload = await this.host.load(this.state);
      this.panel.title = `版本树 · ${this.state.filePath}`;
      await this.post({ type: 'payload', payload });
    } catch (err) {
      await this.post({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.reloading = false;
      await this.post({ type: 'busy', value: false });
      if (this.queued) {
        this.queued = false;
        void this.reload();
      }
    }
  }

  private async onMessage(message: unknown): Promise<void> {
    const msg = (message ?? {}) as Record<string, unknown>;
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        if (this.queued) {
          this.queued = false;
          void this.reload();
        }
        break;
      case 'refresh':
        this.host.invalidate(this.state);
        this.requestReload();
        break;
      case 'setFollow':
        this.state = { ...this.state, follow: Boolean(msg.value) };
        this.host.remember({ follow: this.state.follow });
        this.host.invalidate(this.state);
        this.requestReload();
        break;
      case 'setScope': {
        const scope = readScope(msg.value);
        if (scope !== this.state.scope) {
          this.state = { ...this.state, scope };
          this.host.remember({ scope });
          this.host.invalidate(this.state);
          this.requestReload();
        }
        break;
      }
      case 'openDiff': {
        // 合并节点上按住 Alt 点 = 看改动源头那个版本，否则看本分支的合并前后对比
        const alt = Boolean(msg.alt);
        const altSha = typeof msg.altSha === 'string' ? msg.altSha : '';
        const sha = alt && altSha ? altSha : String(msg.sha ?? '');
        if (sha) await this.host.openDiff(sha, this.state);
        break;
      }
      case 'saveSvg':
        await this.saveSvg(String(msg.xml ?? ''));
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(String(msg.text ?? ''));
        break;
      case 'toast':
        this.host.toast(String(msg.text ?? ''));
        break;
      default:
        break;
    }
  }

  private async saveSvg(xml: string): Promise<void> {
    if (!xml) return;
    const base = this.state.filePath.split('/').pop() || 'version-tree';
    const suggested = vscode.Uri.joinPath(
      vscode.Uri.file(this.state.repoRoot),
      `${base}.version-tree.svg`,
    );
    const target = await vscode.window.showSaveDialog({
      defaultUri: suggested,
      filters: { SVG: ['svg'] },
      saveLabel: '保存',
    });
    if (!target) return;
    const text = '<?xml version="1.0" encoding="UTF-8"?>\n' + xml;
    await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
    this.host.toast(`已导出 ${target.path.split('/').pop()}`);
  }

  private post(message: unknown): Thenable<boolean> {
    return this.panel.webview.postMessage(message);
  }

  private dispose(): void {
    VersionTreePanel.current = null;
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private renderHtml(): string {
    const webview = this.panel.webview;
    const asset = (...parts: string[]): vscode.Uri =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...parts));

    const nonce = makeNonce();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link rel="stylesheet" href="${asset('media', 'theme.css')}" />
<link rel="stylesheet" href="${asset('media', 'panel.css')}" />
<title>版本树</title>
</head>
<body>
<div id="bar">
  <span class="path" id="filePath">${escapeHtml(this.state.filePath)}</span>
  <span class="spacer"></span>
  <span id="stats"></span>
  <span class="seg" id="scopeSeg" title="看哪些分支">
    <button type="button" data-scope="local">本地</button>
    <button type="button" data-scope="remote">远程</button>
    <button type="button" data-scope="all">全部</button>
  </span>
  <label><input type="checkbox" id="optFollow" /> 跟随重命名</label>
  <button id="refreshBtn" title="丢掉缓存重新读取">刷新</button>
  <button id="exportBtn" title="把当前视图导出成 SVG">导出 SVG</button>
</div>
<pre id="warnings" class="warnings hidden"></pre>
<div id="canvas"><svg id="svg" xmlns="http://www.w3.org/2000/svg"></svg></div>
<script nonce="${nonce}" src="${asset('media', 'graph.js')}"></script>
<script nonce="${nonce}" src="${asset('media', 'main.js')}"></script>
</body>
</html>`;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** webview 那边可能传来任何东西，夹成合法范围。 */
function readScope(value: unknown): BranchScope {
  return value === 'remote' || value === 'all' ? value : 'local';
}
