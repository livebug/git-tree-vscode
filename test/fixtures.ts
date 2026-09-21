/**
 * 测试用的仓库构造器。
 *
 * 移植自 git-tree 的 tests/conftest.py：
 *  - 提交时间戳必须是**固定**的（BASE_DAY + n 天），否则 git 用当前时间造出的
 *    提交顺序会随运行时间漂移，断言就不稳
 *  - `GIT_AUTHOR_DATE` 和 `GIT_COMMITTER_DATE` 要一起设，git 会优先用 committer date
 *  - `commit.gpgsign=false`，不然开着签名校验的机器上造不出提交
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** 2026-09-01，所有 fixture 的时间基准。 */
export const BASE_DAY = 1788220800;

export class RepoBuilder {
  private day = 0;

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.git('init', '-q', '-b', 'master');
    this.git('config', 'user.email', 'fixture@example.com');
    this.git('config', 'user.name', 'Fixture');
    this.git('config', 'commit.gpgsign', 'false');
  }

  git(...args: string[]): string {
    const res = spawnSync('git', ['-C', this.dir, ...args], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (res.status !== 0) {
      throw new Error(`git ${args.join(' ')} 失败: ${res.stderr || res.stdout}`);
    }
    return (res.stdout ?? '').trim();
  }

  private dateEnv(): NodeJS.ProcessEnv {
    const stamp = `${BASE_DAY + this.day * 86400} +0000`;
    return { ...process.env, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp };
  }

  at(day: number): this {
    this.day = day;
    return this;
  }

  write(name: string, text: string): this {
    const full = path.join(this.dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text, 'utf8');
    return this;
  }

  commit(message: string): this {
    this.git('add', '-A');
    const res = spawnSync(
      'git',
      ['-C', this.dir, 'commit', '-q', '--allow-empty', '-m', message],
      { env: this.dateEnv(), encoding: 'utf8', windowsHide: true },
    );
    if (res.status !== 0) throw new Error(`commit 失败: ${res.stderr || res.stdout}`);
    return this;
  }

  branch(name: string, start: string): this {
    this.git('checkout', '-q', '-b', name, start);
    return this;
  }

  checkout(name: string): this {
    this.git('checkout', '-q', name);
    return this;
  }

  merge(name: string, label?: string): this {
    const res = spawnSync(
      'git',
      ['-C', this.dir, 'merge', '-q', '--no-ff', name, '-m', label ?? `PR merge ${name}`],
      { env: this.dateEnv(), encoding: 'utf8', windowsHide: true },
    );
    if (res.status !== 0) throw new Error(`merge ${name} 失败: ${res.stderr || res.stdout}`);
    return this;
  }
}

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * 小仓库：master → dev → uat → release 的基线，加三个功能分支和一个冲突分支。
 *
 * 拓扑（与 conftest.py 一致）：
 *
 *     master ──┬─ dev ── uat ── release
 *              │    ↑       ↑
 *              ├─ fb-a ─────┘          从 master 拉出，合并到 dev
 *              ├─ fb-b ─────────────┐  从 master 拉出，绕开 dev 直接去 uat
 *              └─ fb-c              │  未合并
 *                  └─ conf-x ───────┘  从 fb-b 拆出的冲突分支，合回 uat
 */
export function buildSimpleRepo(dir: string): void {
  const b = new RepoBuilder(dir);

  b.at(0).write('README.md', '# demo\n').commit('初始化仓库');
  b.at(1).write('src/app.js', '// app\nconst FLAGS = {}\n').commit('M-1 基础骨架');

  b.at(2).branch('dev', 'master');
  b.write('config/dev.env', 'LOG=debug\n').commit('D-1 集成流水线');

  b.at(3).branch('uat', 'dev');
  b.write('config/uat.env', 'LOG=info\n').commit('U-1 验收环境');

  b.at(4).branch('release', 'uat');
  b.write('config/release.env', 'LOG=warn\n').commit('R-1 发布配置');

  // fb-a：从 master 拉出，合并到 dev
  b.at(5).branch('fb-a', 'master');
  b.write('src/login.js', 'export const login = () => {}\n').commit('fb-a 登录页面');
  b.checkout('dev').at(6).merge('fb-a');

  // fb-b：从 master 拉出，绕开 dev 直接去 uat
  b.at(7).branch('fb-b', 'master');
  b.write('src/pay.js', 'export const pay = () => {}\n').commit('fb-b 支付通道');

  // conf-x：从 fb-b 拆出来解冲突，合回 uat
  b.at(8).branch('conf-x', 'fb-b');
  b.write('src/app.js', '// app\nconst FLAGS = { pay: true }\n').commit('conf-x 解决冲突');
  b.checkout('uat').at(9).merge('conf-x');

  // fb-c：未合并
  b.at(10).branch('fb-c', 'master');
  b.write('src/cart.js', 'export const cart = () => {}\n').commit('fb-c 购物车');

  b.checkout('master');
}

export const SIMPLE_REPO_FIXED = ['master', 'dev', 'uat', 'release'];

/**
 * 企业流程仓库：发布分层 + 回灌 + 冲突分支 + 带日期的发布分支。
 *
 * 重点是造出**"最近的共同祖先"会给出错误答案**的局面：
 * dev / uat 被 master 回灌过之后，它们的 LCA 变成了 master 最后推的东西，
 * 于是用 LCA 当分叉点会把 dev 的父分支判成 conf-dev 之类的东西。
 *
 * 期望值由 **TS 与 Python 双实现交叉验证**得出（见 test/regression.test.ts 的说明），
 * 不是手推的。
 */
export function buildRefRepo(dir: string): void {
  const b = new RepoBuilder(dir);

  b.at(0).write('README.md', '# 支付中台\n').commit('初始化仓库');
  b.at(1).write('src/app.js', '// 应用入口\nconst FLAGS = {}\n').commit('M-1 基础骨架');
  b.at(2).branch('dev', 'master');
  b.write('config/dev.env', 'API_BASE=/api/v1\n').commit('D-1 集成流水线');
  b.at(3).branch('uat', 'dev');
  b.write('config/uat.env', 'API_BASE=/api/uat\n').commit('U-1 验收环境');
  b.at(4).branch('release20260919', 'uat');
  b.write('config/rel1.env', 'API_BASE=/api/rel\n').commit('R-1 发布配置');
  b.at(5).branch('release20261010', 'uat');
  b.write('config/rel2.env', 'API_BASE=/api/rel2\n').commit('R-2 下一班次基线');

  // 第一个功能分支，走完整条发布链
  b.at(6).branch('fb26090101', 'master');
  b.write('src/login.js', 'export const login = () => {}\n').commit('fb26090101 登录');
  b.checkout('dev').at(7).merge('fb26090101', 'PR#1 merge fb26090101 into dev');
  b.checkout('uat').at(8).merge('fb26090101', 'PR#2 merge fb26090101 into uat');
  b.checkout('release20260919')
    .at(9)
    .merge('fb26090101', 'PR#3 merge fb26090101 into release20260919');
  b.checkout('master').at(10).merge('release20260919', 'PR#4 merge release20260919 into master');

  // 自动回灌：master 往 dev / uat 灌回去。
  // 这一步之后，dev/uat 与 master 的"最近共同祖先"就变成 master 的最新提交了。
  b.checkout('dev').at(11).merge('master', 'AUTO merge master into dev');
  b.checkout('uat').at(12).merge('master', 'AUTO merge master into uat');

  // 第二个功能分支：先拆冲突分支并入 uat，自己再进 release
  b.at(13).branch('fb26090102', 'master');
  b.write('src/pay.js', 'export const pay = () => {}\n').commit('fb26090102 支付');
  b.at(14).branch('conf-fb26090102', 'fb26090102');
  b.write('src/app.js', '// 应用入口\nconst FLAGS = { pay: true }\n').commit(
    'conf-fb26090102 解决冲突',
  );
  b.checkout('uat').at(15).merge('conf-fb26090102', 'PR#5 merge conf-fb26090102 into uat');
  // 注意：**不要**再把 conf 合回它自己的来源分支 fb26090102。
  // 那样做会让 fb26090102 的父分支被判成 conf-fb26090102（分叉点离 tip 更近，
  // 候选排序就会选它）—— 见 test/regression.test.ts 里那条 quirk 测试。
  b.checkout('release20260919').at(17).merge('uat', 'PR#7 merge uat into release20260919');
  b.checkout('master').at(18).merge('release20260919', 'PR#8 merge release20260919 into master');

  // 回灌冲突：从 dev 拆出 conf-dev，解完再并进 master
  b.checkout('dev').at(19).branch('conf-dev', 'dev');
  b.write('config/dev.env', 'API_BASE=/api/v1  # 解冲突\n').commit('conf-dev 解决回灌冲突');
  b.checkout('master').at(20).merge('conf-dev', 'PR#9 merge conf-dev into master');

  // 未合并的分支：PR 还在评审
  b.at(21).branch('fb26090301', 'master');
  b.write('src/cart.js', 'export const cart = () => {}\n').commit('fb26090301 购物车');

  b.checkout('master');
}

export const REF_REPO_FIXED = [
  'master',
  'dev',
  'uat',
  'release20260919',
  'release20261010',
];

/** 已由 TS ↔ Python 交叉验证过的期望谱系（见 test/regression.test.ts）。 */
export const REF_REPO_EXPECTED_PARENT: Record<string, string | null> = {
  master: null,
  dev: 'master',
  uat: 'dev',
  release20260919: 'uat',
  release20261010: 'uat',
  'conf-dev': 'dev',
  'conf-fb26090102': 'fb26090102',
  fb26090101: 'master',
  fb26090102: 'master',
  fb26090301: 'master',
};
