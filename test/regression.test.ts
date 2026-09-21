/**
 * 回归断言：下面这些局面**都是真的算错过**的。
 *
 * 它们全部来自 git-tree 的开发记录（改 `_resolve_lineage` 的过程）：
 *
 *   1. 用「最近共同祖先」当分叉点 → 回灌之后把 dev 的父分支判成 conf-dev、
 *      把 fb* 判成 release*
 *   2. 排序键把 tipmatch / isFixed 排在 depth 前面 → uat 认了 master、
 *      conf-x 认了 master
 *   3. own 为空的候选没跳过 → 子分支反过来认爹
 *   4. 固定分支归属越层 → master 的正式发版合并被归到最末一个 release
 *
 * `REF_REPO_EXPECTED_PARENT` 里的期望值是**交叉验证**得来的，不是手推的：
 * 同样的 REF 拓扑分别跑本实现与 git-tree 的 Python `build_branch_graph()`，
 * 14 个分支的 parent / own / reach / kind 全部一致，之后才抄进 test/fixtures.ts。
 * 这次比对是一次性的（本项目不依赖 Python），但它是这些断言可信的依据。
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { after, test } from 'node:test';

import { buildLanes } from '../src/filegraph';
import { LaneInfo } from '../src/lineage';
import { RepoHandle } from '../src/repo';
import { RepoBuilder, REF_REPO_EXPECTED_PARENT, REF_REPO_FIXED, buildRefRepo, tempDir } from './fixtures';

const built: string[] = [];

function refFixture(): { dir: string; handle: RepoHandle } {
  const dir = tempDir('gittree-reg-ref-');
  buildRefRepo(dir);
  built.push(dir);
  return { dir, handle: new RepoHandle(dir) };
}

after(() => {
  for (const dir of built) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 整张拓扑表
// ---------------------------------------------------------------------------

test('企业流程仓库：每个分支的父分支都与参考实现一致', () => {
  const { handle } = refFixture();
  const lanes = new Map(buildLanes(handle, REF_REPO_FIXED).map((l) => [l.name, l]));

  const actual: Record<string, string | null> = {};
  for (const [name, lane] of lanes) actual[name] = lane.parentName;

  for (const [name, expected] of Object.entries(REF_REPO_EXPECTED_PARENT)) {
    assert.equal(actual[name], expected, `${name} 的父分支不对（实际 ${actual[name]}）`);
  }
});

test('企业流程仓库：固定分支的层级是 master → dev → uat → release*', () => {
  const { handle } = refFixture();
  const lanes = new Map(buildLanes(handle, REF_REPO_FIXED).map((l) => [l.name, l]));
  const parent = (name: string): string | null => lanes.get(name)?.parentName ?? null;

  assert.equal(parent('master'), null, 'master 是层级的根，没有父分支');
  assert.equal(parent('dev'), 'master');
  assert.equal(parent('uat'), 'dev');
  assert.equal(parent('release20260919'), 'uat');
  assert.equal(parent('release20261010'), 'uat');
});

test('企业流程仓库：功能分支从 master 拉出，冲突分支认它的来源功能分支', () => {
  const { handle } = refFixture();
  const lanes = new Map(buildLanes(handle, REF_REPO_FIXED).map((l) => [l.name, l]));
  const parent = (name: string): string | null => lanes.get(name)?.parentName ?? null;

  assert.equal(parent('fb26090101'), 'master');
  assert.equal(parent('fb26090102'), 'master');
  assert.equal(parent('fb26090301'), 'master', '未合并的分支也要能正确归属');
  assert.equal(parent('conf-fb26090102'), 'fb26090102', '冲突分支认它拆出来的那个功能分支');
  assert.equal(parent('conf-dev'), 'dev', '回灌冲突分支认 dev');
});

// ---------------------------------------------------------------------------
// 具体的"曾经算错"的场景
// ---------------------------------------------------------------------------

test('回归：回灌之后 dev 不会被判成从 conf-dev 分出来', () => {
  // master 回灌进 dev 之后，dev 与 master 的「最近共同祖先」是 master 的最新提交。
  // 用 LCA 当分叉点，dev 就会去认 conf-dev（它是从 dev 拆出来的，链上更近）。
  const { handle } = refFixture();
  const lanes = new Map(buildLanes(handle, REF_REPO_FIXED).map((l) => [l.name, l]));
  assert.equal(lanes.get('dev')?.parentName, 'master');
});

test('回归：uat 不会被 master 抢走', () => {
  // 排序键若把 "正好切在对方 tip 上"（tipmatch）或 "固定分支优先"（isFixed）
  // 排在 depth 前面，uat 的父分支就会变成 master。
  const { handle } = refFixture();
  const lanes = new Map(buildLanes(handle, REF_REPO_FIXED).map((l) => [l.name, l]));
  assert.equal(lanes.get('uat')?.parentName, 'dev');
  assert.notEqual(lanes.get('uat')?.parentName, 'master');
});

test('回归：两个发布分支不会被互相顶替，也不会越层', () => {
  // 曾经出现过 master 的正式发版合并被归到最末一个 release 分支的情况。
  const { handle } = refFixture();
  const lanes = new Map(buildLanes(handle, REF_REPO_FIXED).map((l) => [l.name, l]));

  assert.equal(lanes.get('release20260919')?.parentName, 'uat');
  assert.equal(lanes.get('release20261010')?.parentName, 'uat');
  // 后加进来的 release 不能反过来当先来的那个的爹
  assert.notEqual(lanes.get('release20260919')?.parentName, 'release20261010');
});

// ---------------------------------------------------------------------------
// 已知怪癖（不是我们认为"对"的行为，是参考实现的行为）
// ---------------------------------------------------------------------------

test('已知怪癖：把冲突分支合回它自己的来源分支，会让来源分支反过来认它当爹', () => {
  // 实际流程里不会这么干（conf 拆出来后是并进 uat / release，不会再合回 fb），
  // 所以这只是记录行为边界。写在这里是为了让"哪天有人动排序键"时能看见它。
  //
  // 原因：conf 的第一父链与 fb 的第一父链在 fb 自己的提交处相交（depth=1），
  // 而 master 要走到 depth=2 才相交——按 depth 优先，conf 胜出。
  // 这与 git-tree 的 Python 实现行为一致（已交叉验证）。
  const dir = tempDir('gittree-quirk-');
  built.push(dir);

  const b = new RepoBuilder(dir);
  b.at(0).write('a.txt', '1\n').commit('init');
  b.at(1).branch('dev', 'master');
  b.write('d.txt', '1\n').commit('D-1');
  b.at(2).branch('fb', 'master');
  b.write('f.txt', '1\n').commit('fb work');
  b.at(3).branch('conf', 'fb');
  b.write('a.txt', '2\n').commit('conf fix');
  b.checkout('fb').at(4).merge('conf'); // ← 就是把 conf 合回来源分支这一步
  b.checkout('dev').at(5).merge('conf');
  b.checkout('master');

  const lanes = new Map(buildLanes(new RepoHandle(dir), ['master', 'dev']).map((l) => [l.name, l]));
  assert.equal(
    lanes.get('fb')?.parentName,
    'conf',
    '这是记录下来的行为；如果你刚改了排序键导致这里变了，请确认是有意为之',
  );
});

test('已知怪癖：把 conf 并进 uat 而不是合回 fb 时，归属是正常的', () => {
  const dir = tempDir('gittree-quirk2-');
  built.push(dir);

  const b = new RepoBuilder(dir);
  b.at(0).write('a.txt', '1\n').commit('init');
  b.at(1).branch('dev', 'master');
  b.write('d.txt', '1\n').commit('D-1');
  b.at(2).branch('uat', 'dev');
  b.write('u.txt', '1\n').commit('U-1');
  b.at(3).branch('fb', 'master');
  b.write('f.txt', '1\n').commit('fb work');
  b.at(4).branch('conf', 'fb');
  b.write('a.txt', '2\n').commit('conf fix');
  b.checkout('uat').at(5).merge('conf'); // ← 实际流程：并进 uat
  b.checkout('master');

  const lanes = new Map(
    buildLanes(new RepoHandle(dir), ['master', 'dev', 'uat']).map((l) => [l.name, l]),
  );
  assert.equal(lanes.get('fb')?.parentName, 'master', 'fb 仍然是从 master 拉出来的');
  assert.equal(lanes.get('conf')?.parentName, 'fb', 'conf 认它拆出来的 fb');
});

// ---------------------------------------------------------------------------
// 辅助：确保 fixture 本身没退化
// ---------------------------------------------------------------------------

test('fixture 自检：REF 仓库确实包含回灌和未合并分支', () => {
  const { handle } = refFixture();
  const lanes = new Map<string, LaneInfo>(
    buildLanes(handle, REF_REPO_FIXED).map((l) => [l.name, l]),
  );
  const store = handle.store();

  // 回灌：dev 的第一父链上应当有一次"把 master 并进来"的合并。
  // 注意不能拿当前的 master.tip 去比对——回灌带进来的是**当时**的 master tip，
  // 之后 master 还在继续往前走（这也是"最近共同祖先"会算错的原因）。
  const devChain = store.firstParentChain(lanes.get('dev')?.tip as number);
  const masterTip = lanes.get('master')?.tip as number;
  const masterReach = lanes.get('master')?.reach as Set<number>;
  const backflow = devChain
    .filter((i) => store.parents[i].length > 1)
    .some((m) => store.parents[m].slice(1).some((p) => masterReach.has(p)));
  assert.ok(backflow, 'dev 上应当能看到一次把 master 并进来的回灌合并');

  // 而且 master 的**当前** tip 不该在 dev 的第一父链上，否则这个 fixture 就不足以
  // 区分"分叉点"和"最近共同祖先"了。
  assert.ok(
    !devChain.includes(masterTip),
    'master 的 tip 不该在 dev 的第一父链上（这正是回灌会让 LCA 失效的原因）',
  );

  // 未合并：fb26090301 的 tip 不在任何固定分支的可达集合里
  const fbTip = lanes.get('fb26090301')?.tip as number;
  for (const name of REF_REPO_FIXED) {
    assert.ok(
      !lanes.get(name)?.reach.has(fbTip),
      `fb26090301 应该还没合并，但它已经在 ${name} 里了`,
    );
  }
});
