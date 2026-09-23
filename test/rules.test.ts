/**
 * 规则断言：把 git-tree/DEVELOPMENT.md §4 的规则**直接写成可执行的检查**。
 *
 * 本项目与 git-tree 零耦合，不做"持续和 Python 实现比对"的门禁；替代方案是把
 * 规则本身固化在这里——改动算法时，违反规则会立刻变红。
 *
 * 期望值不是手推的：REF 拓扑先在两个实现上跑过一次交叉验证（14 个分支全部一致）
 * 之后才写进断言。详见 test/regression.test.ts 顶部的说明。
 *
 * 覆盖范围：规则 1-4、7。**规则 5/6（mergedInto、合并边）属于分支图**，
 * 本扩展只画单文件版本树、不做分支图，所以不在这里断言。
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { after, test } from 'node:test';

import { buildFileGraph, buildLanes } from '../src/filegraph';
import { LaneInfo } from '../src/lineage';
import { RepoHandle } from '../src/repo';
import {
  REF_REPO_FIXED,
  SIMPLE_REPO_FIXED,
  buildRefRepo,
  buildSimpleRepo,
  tempDir,
} from './fixtures';

// ---------------------------------------------------------------------------
// 共用的 fixture（造一次，整个文件复用；每个提交都要 spawn 一次 git，不便宜）
// ---------------------------------------------------------------------------

interface Fixture {
  dir: string;
  handle: RepoHandle;
}

const built: string[] = [];

function makeFixture(prefix: string, build: (dir: string) => void): Fixture {
  const dir = tempDir(prefix);
  build(dir);
  built.push(dir);
  return { dir, handle: new RepoHandle(dir) };
}

let refCache: Fixture | null = null;
function ref(): Fixture {
  if (!refCache) refCache = makeFixture('gittree-rules-ref-', buildRefRepo);
  return refCache;
}

let simpleCache: Fixture | null = null;
function simple(): Fixture {
  if (!simpleCache) simpleCache = makeFixture('gittree-rules-simple-', buildSimpleRepo);
  return simpleCache;
}

after(() => {
  for (const dir of built) fs.rmSync(dir, { recursive: true, force: true });
});

function lanesByName(handle: RepoHandle, fixed: readonly string[]): Map<string, LaneInfo> {
  return new Map(buildLanes(handle, fixed).map((lane) => [lane.name, lane]));
}

function lane(lanes: Map<string, LaneInfo>, name: string): LaneInfo {
  const found = lanes.get(name);
  assert.ok(found, `fixture 里应该有分支 ${name}`);
  return found;
}

/** 集合比较（用排序后的数组，deepEqual 才有确定的失败信息）。 */
function sameSet(actual: ReadonlySet<number>, expected: ReadonlySet<number>, message: string): void {
  const a = [...actual].sort((x, y) => x - y);
  const b = [...expected].sort((x, y) => x - y);
  assert.deepEqual(a, b, message);
}

// ---------------------------------------------------------------------------
// 规则 1：分叉点 = 两条第一父链的分歧点，不是"最近共同祖先"
// ---------------------------------------------------------------------------

test('规则1：分叉点落在父分支的第一父链上', () => {
  const { handle } = ref();
  const store = handle.store();
  const lanes = lanesByName(handle, REF_REPO_FIXED);

  const dev = lane(lanes, 'dev');
  const master = lane(lanes, 'master');
  const masterChain = new Set(store.firstParentChain(master.tip as number));

  assert.ok(dev.fork !== null, 'dev 应该有分叉点');
  assert.ok(
    masterChain.has(dev.fork as number),
    'dev 的分叉点必须落在 master 的第一父链上——这就是规则 1 的定义',
  );
});

test('规则1：回灌之后，"最近共同祖先"与分叉点必须不是同一个提交', () => {
  const { handle } = ref();
  const store = handle.store();
  const lanes = lanesByName(handle, REF_REPO_FIXED);

  const dev = lane(lanes, 'dev');
  const master = lane(lanes, 'master');
  const masterAncestors = store.ancestors(master.tip as number);

  // 这就是"最近共同祖先"会给出的答案
  const lca = [...store.ancestors(dev.tip as number)]
    .filter((i) => masterAncestors.has(i))
    .sort((a, b) => store.ts[b] - store.ts[a])[0];

  // 这条断言是在检查**fixture 本身**：如果两者相等，说明这个仓库没有回灌，
  // 那下面那条断言就等于没测。
  assert.notEqual(
    lca,
    dev.fork,
    '需要 fixture 里存在 master→dev 的回灌，否则这条规则测不到',
  );
  assert.equal(dev.parentName, 'master', 'dev 是从 master 分出来的');
});

// ---------------------------------------------------------------------------
// 规则 2：候选排序键 = (-depth, tipmatch, isFixed, -lane)，且 own 为空的候选跳过
// ---------------------------------------------------------------------------

test('规则2：被回灌的分支不会认成回灌源（depth 必须排在排序键第一位）', () => {
  const { handle } = ref();
  const lanes = lanesByName(handle, REF_REPO_FIXED);

  // uat 被 master 回灌过。如果把"正好切在对方 tip 上"或"固定分支优先"排在
  // depth 前面，uat 就会认 master（历史 bug）。这里锁死它认 dev。
  assert.equal(lane(lanes, 'uat').parentName, 'dev');
  assert.equal(lane(lanes, 'dev').parentName, 'master');
});

test('规则2：认了父分支的分支，own 必须非空', () => {
  const { handle } = ref();
  const lanes = lanesByName(handle, REF_REPO_FIXED);

  for (const item of lanes.values()) {
    if (item.parentName === null) continue;
    assert.ok(
      item.own.size > 0,
      `${item.name} 认了父分支 ${item.parentName}，但 own 是空集` +
        '（own 为空的候选应该在排序阶段就被跳掉，否则子分支会反过来认爹）',
    );
  }
});

// ---------------------------------------------------------------------------
// 规则 3：固定分支只从"排在它上面"的分支分出来
// ---------------------------------------------------------------------------

test('规则3：固定分支的父分支一定是它上面那一层', () => {
  const { handle } = ref();
  const lanes = lanesByName(handle, REF_REPO_FIXED);

  for (const name of REF_REPO_FIXED) {
    const item = lane(lanes, name);
    if (item.parentName === null) continue;
    assert.ok(
      REF_REPO_FIXED.includes(item.parentName),
      `${name} 的父分支 ${item.parentName} 应该是固定分支里的一员`,
    );
    assert.ok(
      REF_REPO_FIXED.indexOf(item.parentName) < REF_REPO_FIXED.indexOf(name),
      `${name} 不能从排在它后面的 ${item.parentName} 分出来（顺序即发布层级）`,
    );
  }
});

test('规则3：两个发布分支都挂在 uat 下面', () => {
  const { handle } = ref();
  const lanes = lanesByName(handle, REF_REPO_FIXED);
  assert.equal(lane(lanes, 'release20260919').parentName, 'uat');
  assert.equal(lane(lanes, 'release20261010').parentName, 'uat');
});

// ---------------------------------------------------------------------------
// 规则 4：own 的两种定义
// ---------------------------------------------------------------------------

test('规则4：固定分支的 own = 自己的第一父链 − 父分支的第一父链', () => {
  const { handle } = ref();
  const store = handle.store();
  const lanes = lanesByName(handle, REF_REPO_FIXED);

  const dev = lane(lanes, 'dev');
  const master = lane(lanes, 'master');
  const expected = new Set(
    store.firstParentChain(dev.tip as number).filter(
      (i) => !new Set(store.firstParentChain(master.tip as number)).has(i),
    ),
  );
  sameSet(dev.own, expected, 'dev 的 own 应当是"这条集成线比 master 多出来的部分"');
});

test('规则4：开发分支的 own = reach − ancestors(分叉点)', () => {
  const { handle } = ref();
  const store = handle.store();
  const lanes = lanesByName(handle, REF_REPO_FIXED);

  for (const name of ['fb26090101', 'conf-fb26090102', 'conf-dev']) {
    const item = lane(lanes, name);
    assert.ok(item.fork !== null, `${name} 应该有分叉点`);
    const expected = new Set(
      [...item.reach].filter((i) => !store.ancestors(item.fork as number).has(i)),
    );
    sameSet(item.own, expected, `${name} 的 own 应当是"分叉之后自己做的提交"`);
  }
});

test('规则4：own 是 reach 的子集，且不含分叉点', () => {
  const { handle } = ref();
  const lanes = lanesByName(handle, REF_REPO_FIXED);
  for (const item of lanes.values()) {
    for (const i of item.own) {
      assert.ok(item.reach.has(i), `${item.name} 的 own 里出现了 reach 之外的提交`);
    }
    if (item.fork !== null) {
      assert.ok(!item.own.has(item.fork), `${item.name} 的 own 不应该包含分叉点本身`);
    }
  }
});

// ---------------------------------------------------------------------------
// 规则 7：单文件历史 —— 谁改的，谁只是承载
// ---------------------------------------------------------------------------

test('规则7：作者是"第一父链包含该提交且最具体"的分支', () => {
  const { handle } = simple();
  const payload = buildFileGraph(handle, 'src/pay.js', SIMPLE_REPO_FIXED);

  const authors = payload.lanes.filter((l) => l.role === 'author').map((l) => l.name);
  assert.deepEqual(authors, ['fb-b'], 'src/pay.js 只被 fb-b 改过');
});

test('规则7：只继承没修改的固定分支算承载，虚线淡显', () => {
  const { handle } = simple();
  const payload = buildFileGraph(handle, 'src/pay.js', SIMPLE_REPO_FIXED);
  const byName = new Map(payload.lanes.map((l) => [l.name, l]));

  assert.equal(byName.get('uat')?.role, 'carrier', '改动经 conf-x 并进了 uat');
  assert.equal(byName.has('master'), false, '这个改动从没到过 master，不该出现在轨道里');
  assert.equal(byName.has('dev'), false, 'fb-b 绕开了 dev');
});

test('规则7：传播边要求改动是从非第一父"带进来"的', () => {
  const { handle } = simple();
  const payload = buildFileGraph(handle, 'src/pay.js', SIMPLE_REPO_FIXED);

  const merges = payload.edges.filter((e) => e.kind === 'merge');
  assert.equal(merges.length, 1, '只应该有一条传播边');
  const edge = merges[0];

  const from = payload.lanes.find((l) => l.lane === edge.fromLane);
  const to = payload.lanes.find((l) => l.lane === edge.toLane);
  assert.equal(from?.name, 'fb-b');
  assert.equal(to?.name, 'uat');
  assert.equal(edge.fromKind, 'version', '源头是 fb-b 的版本节点');

  // uat 自己没改过这个文件，箭头就落在 uat 上的**合并节点**（那次把改动带进来的合并），
  // 点它就是 `git diff <合并提交>^1 <合并提交> -- src/pay.js`，即 uat 上的前后对比。
  assert.equal(edge.targetNode?.kind, 'merge');
  const node = payload.nodes.find((n) => n.sha === edge.targetNode?.sha);
  assert.equal(node?.kind, 'merge');
  assert.equal(node?.lane, to?.lane);
});

test('规则7：提交表里的 origin / containing 与轨道一致', () => {
  const { handle } = simple();
  const payload = buildFileGraph(handle, 'src/pay.js', SIMPLE_REPO_FIXED);
  const commit = payload.commits[0];

  assert.equal(commit.origin, 'fb-b');
  assert.ok(commit.containing.includes('uat'), 'uat 现在含有这个改动');
  assert.ok(!commit.containing.includes('dev'), 'dev 不含有这个改动');
  assert.equal(commit.status, '新增');
});

test('规则7：路径不存在时给警告而不是抛异常', () => {
  const { handle } = simple();
  const payload = buildFileGraph(handle, 'does/not/exist.txt', SIMPLE_REPO_FIXED);

  assert.deepEqual(payload.commits, []);
  assert.ok(payload.warnings.length > 0);
  assert.deepEqual(payload.lanes, []);
});

test('契约：payload 的字段够渲染器画出版本树', () => {
  const { handle } = simple();
  const payload = buildFileGraph(handle, 'src/pay.js', SIMPLE_REPO_FIXED);

  // CONTRACT.md 里冻结的形状——_drawLanesVT / _drawEdgesVT / _drawNodesVT 直接读这些键
  assert.equal(payload.path, 'src/pay.js');
  assert.ok(payload.range.maxTs >= payload.range.minTs);
  assert.equal(payload.nodes.filter((n) => n.kind === 'version').length, 1, '一个版本节点');
  assert.equal(payload.nodes.filter((n) => n.kind === 'merge').length, 1, '一个合并节点');

  for (const item of payload.lanes) {
    assert.equal(typeof item.color, 'string');
    assert.ok(['author', 'carrier'].includes(item.role));
    assert.equal(typeof item.x1, 'number');
    assert.equal(typeof item.x2, 'number');
    for (const version of item.versions) {
      assert.equal(typeof version.n, 'number');
      assert.equal(typeof version.x, 'number');
      assert.ok(Array.isArray(version.labels));
      assert.ok(version.x >= 0 && version.x <= 1, 'version.x 必须是归一化到 [0,1] 的时间');
    }
  }
  for (const node of payload.nodes) {
    assert.ok(node.x >= 0 && node.x <= 1, 'node.x 必须是归一化到 [0,1] 的时间');
    assert.ok(Array.isArray(node.labels));
  }
});
