/**
 * 分支筛选：glob 匹配、按名字挑 ref、默认选择，以及“筛选只隐藏轨道，不改提交归属”。
 *
 * 这些是纯函数 + fixture 上的行为断言，不依赖 VS Code。
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { after, test } from 'node:test';

import { buildFileGraph } from '../src/filegraph';
import { RepoHandle, RefInfo, defaultBranchSelection, globMatch, matchBranchPatterns, selectRefs } from '../src/repo';
import {
  REF_REPO_FIXED,
  SIMPLE_REPO_FIXED,
  buildRefRepo,
  buildSimpleRepo,
  tempDir,
} from './fixtures';

function ref(name: string, remote = false): RefInfo {
  return { name, sha: '0'.repeat(40), ts: 0, subject: '', remote };
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('globMatch：* / ? 与字面量', () => {
  assert.equal(globMatch('release*', 'release20260919'), true);
  assert.equal(globMatch('release*', 'dev'), false);
  assert.equal(globMatch('fb-?', 'fb-a'), true);
  assert.equal(globMatch('fb-?', 'fb-ab'), false);
  assert.equal(globMatch('dev', 'dev'), true);
  // 正则元字符必须按字面量处理，不能变成通配
  assert.equal(globMatch('a.b', 'axb'), false);
  assert.equal(globMatch('a+b', 'axb'), false);
  assert.equal(globMatch('release*', 'Release1'), false, '分支名大小写敏感');
});

test('matchBranchPatterns：短名去重，本地/远端写法都认', () => {
  const refs = [ref('dev'), ref('origin/dev', true), ref('origin/release20260919', true), ref('fb-a')];
  assert.deepEqual(matchBranchPatterns(refs, ['dev']), ['dev']);
  assert.deepEqual(matchBranchPatterns(refs, ['release*']), ['release20260919']);
  assert.deepEqual(matchBranchPatterns(refs, ['origin/dev']), ['dev']);
  assert.deepEqual(matchBranchPatterns(refs, ['nope*']), []);
  assert.deepEqual(matchBranchPatterns(refs, []), []);
});

test('selectRefs：按名字筛，短名能匹配 origin/*', () => {
  const refs = [ref('master'), ref('dev'), ref('origin/dev', true), ref('origin/release1', true)];

  const local = selectRefs(refs, 'local', new Set(['dev'])).map((r) => r.name);
  assert.deepEqual(local, ['dev']);

  const remote = selectRefs(refs, 'remote', new Set(['dev'])).map((r) => r.name);
  assert.deepEqual(remote, ['origin/dev'], '短名 dev 要能匹配 origin/dev');

  const all = selectRefs(refs, 'all', new Set(['dev', 'release1'])).map((r) => r.name);
  assert.deepEqual(all, ['dev', 'origin/release1'], 'all 会去掉同名远端镜像');
});

test('defaultBranchSelection：配置优先，配空退回固定分支', () => {
  const refs = [ref('master'), ref('dev'), ref('release20260919')];
  const fixed = ['master', 'dev'];

  const configured = defaultBranchSelection(refs, fixed, ['release*']);
  assert.deepEqual(configured.branches, ['release20260919']);
  assert.equal(configured.patternMiss, false);

  const empty = defaultBranchSelection(refs, fixed, []);
  assert.deepEqual(empty.branches, ['master', 'dev']);
  assert.equal(empty.patternMiss, false);

  const miss = defaultBranchSelection(refs, fixed, ['nope*']);
  assert.deepEqual(miss.branches, ['master', 'dev'], '匹配不上时退回固定分支');
  assert.equal(miss.patternMiss, true);

  const noFixed = defaultBranchSelection(refs, [], []);
  assert.equal(noFixed.branches, null, '连固定分支都没有时显示全部');
});

// ---------------------------------------------------------------------------
// fixture：筛完之后的轨道与谱系
// ---------------------------------------------------------------------------

const built: string[] = [];
let refHandle: RepoHandle | null = null;
let simple: RepoHandle | null = null;

function refRepo(): RepoHandle {
  if (!refHandle) {
    const dir = tempDir('gittree-filter-');
    buildRefRepo(dir);
    built.push(dir);
    refHandle = new RepoHandle(dir);
  }
  return refHandle;
}

function simpleRepo(): RepoHandle {
  if (!simple) {
    const dir = tempDir('gittree-filter-simple-');
    buildSimpleRepo(dir);
    built.push(dir);
    simple = new RepoHandle(dir);
  }
  return simple;
}

after(() => {
  for (const dir of built) fs.rmSync(dir, { recursive: true, force: true });
});

test('筛选不改归属：只选 dev 时，不会把 fb-a 的提交算成 /dev/1', () => {
  const handle = simpleRepo();
  const all = buildFileGraph(handle, 'src/login.js', SIMPLE_REPO_FIXED);
  const fb = all.lanes.find((lane) => lane.name === 'fb-a');
  assert.ok(fb && fb.role === 'author' && fb.versions.length === 1, 'fixture 里 fb-a 才是作者');
  const fbVersionSha = fb.versions[0].sha;

  const filtered = buildFileGraph(handle, 'src/login.js', SIMPLE_REPO_FIXED, {
    branches: ['dev'],
  });
  const dev = filtered.lanes.find((lane) => lane.name === 'dev');
  assert.ok(dev, 'dev 是勾中的分支，应该以承载轨道出现（改动是合并进来的）');
  assert.equal(dev.role, 'carrier');
  assert.equal(dev.versions.length, 0, 'dev 自己没改过这个文件，不能凭空出现版本');
  for (const lane of filtered.lanes) {
    for (const version of lane.versions) {
      assert.notEqual(version.sha, fbVersionSha, 'fb-a 的提交不能挂到别的轨道上');
    }
  }
  assert.ok(
    filtered.nodes.some((node) => node.kind === 'merge'),
    '改动进 dev 的那次合并要保留成合并节点',
  );
});

test('buildFileGraph：branches 过滤生效，且不筛时轨道更多', () => {
  const handle = refRepo();
  const all = buildFileGraph(handle, 'src/pay.js', REF_REPO_FIXED);
  assert.ok(all.lanes.length >= 2, 'fixture 里这个文件应该至少落在两条轨道上');

  const pick = all.lanes.slice(0, 2).map((lane) => lane.name);
  const filtered = buildFileGraph(handle, 'src/pay.js', REF_REPO_FIXED, { branches: pick });

  assert.ok(all.lanes.length > filtered.lanes.length, '不筛的时候轨道应该更多');
  assert.deepEqual(
    filtered.lanes.map((lane) => lane.name).sort(),
    [...pick].sort(),
    '筛选后只该出现勾中的分支',
  );
  assert.equal(filtered.stats.lanes, filtered.lanes.length);

  // 下标必须压紧且自洽：渲染器是按 lane 下标查颜色/坐标的
  assert.deepEqual(
    filtered.lanes.map((lane) => lane.lane).sort((a, b) => a - b),
    filtered.lanes.map((_, i) => i),
    '轨道下标应该从 0 开始连续',
  );
  const laneIds = new Set(filtered.lanes.map((lane) => lane.lane));
  for (const node of filtered.nodes) {
    assert.ok(laneIds.has(node.lane), `节点 ${node.short} 落在不存在的轨道 ${node.lane} 上`);
    if (node.via) {
      assert.ok(
        node.via.lane === -1 || laneIds.has(node.via.lane),
        `合并节点的来源轨道 ${node.via.lane} 既不是 -1 也不存在`,
      );
    }
  }
  for (const edge of filtered.edges) {
    assert.ok(laneIds.has(edge.fromLane) && laneIds.has(edge.toLane), '边的两端都必须是可见轨道');
    if (edge.targetNode) assert.ok(laneIds.has(edge.targetNode.lane));
  }
});

test('buildFileGraph：空筛选 == 不筛', () => {
  const handle = refRepo();
  const all = buildFileGraph(handle, 'src/pay.js', REF_REPO_FIXED);
  const empty = buildFileGraph(handle, 'src/pay.js', REF_REPO_FIXED, { branches: [] });
  assert.equal(empty.lanes.length, all.lanes.length);
});
