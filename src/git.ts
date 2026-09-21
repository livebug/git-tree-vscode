/**
 * git 命令封装。
 *
 * 约定对齐 git-tree 的 backend/gitcmd.py：
 *  - `LC_ALL=C` 让输出稳定（不随机器 locale 变）
 *  - `GIT_PAGER=cat` 防分页；`GIT_TERMINAL_PROMPT=0` 绝不阻塞在凭据提示上
 *  - `GIT_OPTIONAL_LOCKS=0` 只用读操作，不去碰仓库锁
 *
 * REC / FLD 是给 `git --format` 用的分隔符，取的是不会出现在提交信息里的控制字符。
 */

import { spawn, spawnSync } from 'node:child_process';

export const REC = '\x1e'; // record separator
export const FLD = '\x1f'; // field separator

/** git 命令失败。`stderr` 原样保留，方便把原因透给用户。 */
export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number,
    readonly stderr: string,
  ) {
    super(stderr.trim() || `git ${args.join(' ')} 退出码 ${code}`);
    this.name = 'GitError';
  }
}

export interface RunOptions {
  /** 超时（毫秒）。默认 5 分钟。 */
  timeoutMs?: number;
}

/** 大仓库 `git log --all` 可能有几十 MB 输出，默认 1MB 的 maxBuffer 会截断。 */
const MAX_BUFFER = 512 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 300_000;

export class Git {
  /** 仓库路径（工作区或裸仓库）。 */
  readonly path: string;

  constructor(
    path: string,
    private readonly gitPath = 'git',
  ) {
    this.path = path;
  }

  run(args: string[], options: RunOptions = {}): string {
    const res = spawnSync(this.gitPath, ['-C', this.path, ...args], {
      env: this.env(),
      maxBuffer: MAX_BUFFER,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      windowsHide: true,
    });

    if (res.error) {
      const code = (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 124 : 127;
      throw new GitError(args, code, res.error.message);
    }
    if (res.status !== 0) {
      throw new GitError(args, res.status ?? -1, String(res.stderr ?? ''));
    }
    return String(res.stdout ?? '');
  }

  /**
   * 异步版本。
   *
   * 扩展宿主是所有扩展共享的**同一个进程**，`spawnSync` 会把它整个卡住。
   * 几百毫秒还能忍，但大仓库上 `git log --all` 要好几秒——那就是把别人的扩展
   * 一起冻住。所以只有**可能很慢**的那几条命令（`log --all`、`log --name-status`）
   * 走这里，其余快命令继续用同步版本（代码干净得多，也不用把整个算法改成 async）。
   */
  runAsync(args: string[], options: RunOptions = {}): Promise<string> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.gitPath, ['-C', this.path, ...args], {
        env: this.env(),
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let done = false;
      let timer: NodeJS.Timeout | undefined;

      const finish = (fn: () => void): void => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        fn();
      };

      timer = setTimeout(() => {
        child.kill();
        finish(() => reject(new GitError(args, 124, `git 命令超过 ${timeoutMs}ms 未结束`)));
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (err: Error) => {
        finish(() => reject(new GitError(args, 127, err.message)));
      });
      child.on('close', (code: number | null) => {
        finish(() => {
          if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'));
          else reject(new GitError(args, code ?? -1, Buffer.concat(stderr).toString('utf8')));
        });
      });
    });
  }

  /** 不抛异常，返回 `{ ok, out }`；失败时 `out` 是错误信息。 */
  tryRun(args: string[], options: RunOptions = {}): { ok: boolean; out: string } {
    try {
      return { ok: true, out: this.run(args, options) };
    } catch (err) {
      return { ok: false, out: err instanceof Error ? err.message : String(err) };
    }
  }

  // -- 小工具 --------------------------------------------------------

  isRepo(): boolean {
    return this.tryRun(['rev-parse', '--git-dir'], { timeoutMs: 20_000 }).ok;
  }

  isBare(): boolean {
    const res = this.tryRun(['rev-parse', '--is-bare-repository'], { timeoutMs: 20_000 });
    return res.ok && res.out.trim() === 'true';
  }

  resolve(rev: string): string | null {
    const res = this.tryRun(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], {
      timeoutMs: 30_000,
    });
    const sha = res.out.trim();
    return res.ok && sha ? sha : null;
  }

  /** 当前 HEAD 指向的分支名（游离头时为 null）。 */
  headBranch(): string | null {
    const res = this.tryRun(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      timeoutMs: 20_000,
    });
    const name = res.out.trim();
    return res.ok && name ? name : null;
  }

  /** 仓库顶层目录；裸仓库或无工作区时返回 null。 */
  topLevel(): string | null {
    const res = this.tryRun(['rev-parse', '--show-toplevel'], { timeoutMs: 20_000 });
    const dir = res.out.trim();
    return res.ok && dir ? dir : null;
  }

  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    env.LC_ALL = 'C';
    env.GIT_PAGER = 'cat';
    env.GIT_TERMINAL_PROMPT = '0';
    env.GIT_OPTIONAL_LOCKS = '0';
    return env;
  }
}
