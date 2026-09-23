/**
 * 分支视图的断言：合并节点、连线精简、分支范围。
 *
 * 这三件事都是"看着图用"的行为，不是纯算法，所以单独一个文件：
 *
 *   1. **合并节点** —— "a 合并到 b" 要落在 b 那条轨道的具体位置上。点它就等价于
 *      `git diff <合并提交>^1 <合并提交> -- <文件>`，也就是 b 分支上这个文件的
 *      前后对比。所以这里断言：这个节点确实是个合并提交，而且它的第一父在 b 上。
 *   2. **连线精简** —— 改动一趟走上发布链（fb → uat → release → master）时，
 *      箭头只在**相邻两条轨道之间**接力，而不是从源头顶着一堆线横穿全图。
 *   3. **分支范围** —— 本地 / 远端 / 全部，以及远端命名下（`origin/dev`）发布层级照样认得出来。
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { after, test } from 'node:test';

import { EdgePayload, FileGraphPayload, buildFileGraph, buildLanes } from '../src/filegraph';
import { resolveFixed } from '../src/fixed';
import { RepoHandle } from '../src/repo';
import {
  REF_REPO_FIXED,
  SIMPLE_REPO_FIXED,
  addRemoteBranch,
  buildRefRepo,
  buildSimpleRepo,
  tempDir,
} from './fixtures';

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

let simpleCache: Fixture | null = null;
function simple(): Fixture {
  if (!simpleCache) simpleCache = makeFixture('gittree-view-simple-', buildSimpleRepo);
  return simpleCache;
}

let refCache: Fixture | null = null;
function ref(): Fixture {
  if (!refCache) refCache = makeFixture('gittree-view-ref-', buildRefRepo);
  return refCache;
}

let scopedCache: Fixture | null = null;
/** 小仓库 + 几根假的远端跟踪分支（不搭真远端，update-ref 就够）。 */
function scoped(): Fixture {
  if (!scopedCache) {
    scopedCache = makeFixture('gittree-view-scope-', (dir) => {
      buildSimpleRepo(dir);
      addRemoteBranch(dir, 'origin/master', 'master');
      addRemoteBranch(dir, 'origin/dev', 'dev');
      addRemoteBranch(dir, 'origin/uat', 'uat');
      addRemoteBranch(dir, 'origin/hotfix-remote', 'fb-a');
    });
  }
  return scopedCache;
}

after(() => {
  for (const dir of built) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function lanesByName(payload: FileGraphPayload): Map<string, (typeof payload.lanes)[number]> {
  return new Map(payload.lanes.map((lane) => [lane.name, lane]));
}

function laneOf(payload: FileGraphPayload, name: string): (typeof payload.lanes)[number] {
  const found = lanesByName(payload).get(name);
  assert.ok(found, `轨道里应该有 ${name}（实际：${payload.lanes.map((l) => l.name).join(', ')}）`);
  return found;
}

/** `from → to` 形式的分支对，方便断言“到底有没有这根长线”。只取指定类型。 */
function edgePairs(payload: FileGraphPayload, kind: 'merge' | 'fork'): Map<string, EdgePayload> {
  const byIndex = new Map(payload.lanes.map((lane) => [lane.lane, lane.name]));
  const out = new Map<string, EdgePayload>();
  for (const edge of payload.edges) {
    if (edge.kind !== kind) continue;
    const from = byIndex.get(edge.fromLane) ?? String(edge.fromLane);
    const to = byIndex.get(edge.toLane) ?? String(edge.toLane);
    const key = `${from}→${to}`;
    assert.equal(out.get(key), undefined, `${from}→${to} 出现了两根 ${kind} 边，应该已经去重`);
    out.set(key, edge);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. 合并节点
// ---------------------------------------------------------------------------

test('合并节点：落在接收方轨道上，且就是一个合并提交', () => {
  const { handle } = simple();
  const payload = buildFileGraph(handle, 'src/pay.js', SIMPLE_REPO_FIXED);
  const uat = laneOf(payload, 'uat');

  const merges = payload.nodes.filter((n) => n.lane === uat.lane && n.kind === 'merge');
  assert.equal(merges.length, 1, 'uat 上应该正好有一个合并节点（fb-b 的改动经 conf-x 并进来）');
  const node = merges[0];

  assert.equal(node.n, null, '合并节点没有版本号');
  assert.equal(node.via?.name, 'fb-b', '改动是从 fb-b 那条轨道带进来的');
  assert.equal(node.via?.kind, 'version');
  assert.equal(node.via?.n, 1, '源头是 fb-b 上的 /fb-b/1');

  // 关键：这个提交必须是合并提交，而且它的**第一父**在 uat 上 ——
  // 这样 `合并提交 vs 第一父` 才是"uat 上这个文件的前后对比"，
  // 而不是"uat 相对 fb-b 多了什么"。
  const store = handle.store();
  const mergeIdx = store.get(node.sha);
  assert.notEqual(mergeIdx, undefined);
  const parents = store.parents[mergeIdx as number];
  assert.equal(parents.length, 2, '应该是个两父提交');

  const uatTip = uat.tip as string;
  const uatAncestors = store.ancestors(store.get(uatTip) as number);
  assert.ok(uatAncestors.has(parents[0]), '第一父必须还在 uat 自己的线上（合并前的那个状态）');

  // 箭头也要落在这个节点上（这样图上看到的位置和点开的东西是同一个东西）
  const edge = edgePairs(payload, 'merge').get('fb-b→uat');
  assert.ok(edge, '应该有 fb-b → uat 的合并箭头');
  assert.equal(edge.targetNode?.sha, node.sha);
  assert.equal(edge.fromKind, 'version');
  assert.equal(edge.fromN, 1);
});

test('合并节点：只继承没提交的轨道上也画得出来（改动经合并带进来）', () => {
  const { handle } = ref();
  const payload = buildFileGraph(handle, 'src/pay.js', REF_REPO_FIXED);

  for (const name of ['uat', 'release20260919', 'master']) {
    const lane = laneOf(payload, name);
    const merges = payload.nodes.filter((n) => n.lane === lane.lane && n.kind === 'merge');
    assert.equal(merges.length, 1, `${name} 上应该有一个合并节点`);
    assert.equal(merges[0].via === null, false, `${name} 的合并节点要能说清改动从哪来`);
    assert.equal(lane.mergeCount, 1);
    assert.equal(lane.versions.length, 0, `${name} 自己没有改过这个文件`);
  }

  // 版本号只加在真正改过这个文件的轨道上
  const author = laneOf(payload, 'fb26090102');
  assert.equal(author.versions.length, 1);
  assert.equal(author.versions[0].n, 1);
  assert.equal(author.mergeCount, 0);
});

test('契约：节点区分版本与合并，节点上的 n 与 versions 一致', () => {
  const { handle } = ref();
  const payload = buildFileGraph(handle, 'src/log-in-not-exist.js', REF_REPO_FIXED);
  assert.deepEqual(payload.nodes, []);

  const other = buildFileGraph(handle, 'src/login.js', REF_REPO_FIXED);
  assert.equal(other.scope, 'local');
  for (const lane of other.lanes) {
    for (const version of lane.versions) {
      const node = other.nodes.find((n) => n.sha === version.sha && n.lane === lane.lane);
      assert.equal(node?.kind, 'version');
      assert.equal(node?.n, version.n, `/${lane.name}/${version.n} 的节点号要与 versions 里的一致`);
    }
  }
  for (const node of other.nodes) {
    assert.ok(node.x >= 0 && node.x <= 1, 'node.x 必须归一化到 [0,1]');
    if (node.kind === 'merge') assert.equal(node.via?.lane !== null, true);
  }
});

// ---------------------------------------------------------------------------
// 2. 连线精简：接力而不是横穿
// ---------------------------------------------------------------------------

test('连线精简：一趟走上发布链时箭头只连相邻两条轨道', () => {
  // src/pay.js 的改动：fb26090102 → (conf) → uat → release → master
  const { handle } = ref();
  const payload = buildFileGraph(handle, 'src/pay.js', REF_REPO_FIXED);
  const pairs = edgePairs(payload, 'merge');
  const merges = [...pairs.keys()].sort();

  assert.deepEqual(
    merges,
    ['fb26090102→uat', 'release20260919→master', 'uat→release20260919'],
    '每一跳都只发生在相邻两条轨道之间',
  );

  // 后两跳是从**上一层那条轨道的合并节点**出发的（接力），
  // 而不是从功能分支一路拉回源头——这正是"一堆交叉线"的来源。
  const relay1 = pairs.get('uat→release20260919') as EdgePayload;
  assert.equal(relay1.fromKind, 'merge');
  const uatNode = payload.nodes.find((n) => n.sha === relay1.fromSha);
  assert.equal(uatNode?.kind, 'merge');
  assert.equal(uatNode?.lane, laneOf(payload, 'uat').lane);

  const relay2 = pairs.get('release20260919→master') as EdgePayload;
  assert.equal(relay2.fromKind, 'merge');
  assert.equal(relay2.fromSha, relay1.targetNode?.sha, 'release 上的落点又是下一跳的起点');

  // 没有从功能分支直连上层发布分支的长线
  assert.equal(pairs.has('fb26090102→release20260919'), false);
  assert.equal(pairs.has('fb26090102→master'), false);
});

test('连线精简：上游确实是直接合并的，就还是直连', () => {
  // src/login.js 的改动在 fixture 里是 fb26090101 **分别**并进 dev / uat / release 的，
  // 所以这三根箭头都该直接来自 fb 那条轨道——不要为了"好看"硬拗成接力。
  const { handle } = ref();
  const payload = buildFileGraph(handle, 'src/login.js', REF_REPO_FIXED);
  const pairs = edgePairs(payload, 'merge');

  for (const target of ['dev', 'uat', 'release20260919']) {
    const edge = pairs.get(`fb26090101→${target}`);
    assert.ok(edge, `应该有 fb26090101 → ${target}`);
    assert.equal(edge.fromKind, 'version');
  }
  // 而 master 是通过 release 拿到的（PR#4 合并的是 release20260919）
  assert.equal(pairs.has('fb26090101→master'), false);
  assert.equal(pairs.get('release20260919→master')?.fromKind, 'merge');
});

test('连线精简：分叉线每条轨道只画一根，画在分支点上', () => {
  const { handle } = ref();
  const payload = buildFileGraph(handle, 'src/login.js', REF_REPO_FIXED);
  const forks = payload.edges.filter((e) => e.kind === 'fork');

  const seen = new Set<number>();
  for (const edge of forks) {
    assert.equal(seen.has(edge.toLane), false, '同一条轨道不该有多根分叉线');
    seen.add(edge.toLane);
    assert.equal(edge.x1, edge.x2, '分叉线是分支点那一行上的横线');
    assert.equal(edge.targetNode, null);
  }
});

// ---------------------------------------------------------------------------
// 3. 分支范围：本地 / 远端 / 全部
// ---------------------------------------------------------------------------

test('范围：本地 / 远端 / 全部 各看各的', () => {
  const { handle } = scoped();

  const local = buildLanes(handle, SIMPLE_REPO_FIXED, 'local');
  assert.ok(local.some((l) => l.name === 'dev'));
  assert.equal(local.some((l) => l.remote), false, '本地范围里不该有远端轨道');

  const remote = buildLanes(handle, SIMPLE_REPO_FIXED, 'remote');
  assert.equal(remote.every((l) => l.remote), true, '远端范围里不该混进本地分支');
  assert.deepEqual(
    remote.slice(0, 3).map((l) => l.name),
    ['origin/master', 'origin/dev', 'origin/uat'],
    '远端命名（origin/dev）下发布层级照样认得出，且顺序就是层级顺序',
  );
  assert.ok(remote.some((l) => l.name === 'origin/hotfix-remote'), '远端独有的分支也要在');

  const all = buildLanes(handle, SIMPLE_REPO_FIXED, 'all');
  const names = all.map((l) => l.name);
  assert.ok(names.includes('dev'), '全部范围里保留本地分支');
  assert.ok(names.includes('origin/hotfix-remote'), '远端独有的分支也在');
  assert.equal(names.includes('origin/dev'), false, 'origin/dev 是 dev 的镜像，去重后只画一根轨道');
});

test('范围：远端范围下固定分支照样认得出来', () => {
  const { handle } = scoped();
  const refs = handle.refs();

  const remote = resolveFixed([], refs, 'master', { scope: 'remote', prefixes: ['release'] });
  assert.equal(remote.source, 'auto');
  assert.deepEqual(remote.fixed, ['master', 'dev', 'uat']);

  // 用户直接手写 origin/dev 也要算数
  const explicit = resolveFixed(['origin/dev'], refs, 'master', { scope: 'remote' });
  assert.deepEqual(explicit.fixed, ['origin/dev']);
  assert.equal(explicit.source, 'configured');

  // 本地范围下，远端分支名不该被当成存在的固定分支
  const local = resolveFixed(['origin/dev'], refs, 'master', { scope: 'local' });
  assert.deepEqual(local.fixed, []);
});

test('范围：payload 里带上 scope，远端范围不会改坏单文件历史', () => {
  const { handle } = scoped();
  const payload = buildFileGraph(handle, 'src/login.js', SIMPLE_REPO_FIXED, {
    scope: 'remote',
  });
  assert.equal(payload.scope, 'remote');
  assert.ok(payload.lanes.length > 0, '远端范围也要能画出轨道');
  assert.equal(
    payload.lanes.every((lane) => lane.name.startsWith('origin/')),
    true,
  );
});

test('范围：旧的 includeRemotes=true 等价于 all', () => {
  const { handle } = scoped();
  const payload = buildFileGraph(handle, 'src/login.js', SIMPLE_REPO_FIXED, {
    includeRemotes: true,
  });
  assert.equal(payload.scope, 'all');
});
