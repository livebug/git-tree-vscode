/**
 * 分支筛选：glob 匹配、按名字挑 ref、默认选择，以及筛完之后谱系不能留断线。
 *
 * 这些是纯函数 + fixture 上的行为断言，不依赖 VS Code。
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { after, test } from 'node:test';

import { buildFileGraph, buildLanes } from '../src/filegraph';
import { RepoHandle, RefInfo, defaultBranchSelection, globMatch, matchBranchPatterns, selectRefs } from '../src/repo';
import { REF_REPO_FIXED, buildRefRepo, tempDir } from './fixtures';

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

function refRepo(): RepoHandle {
  if (!refHandle) {
    const dir = tempDir('gittree-filter-');
    buildRefRepo(dir);
    built.push(dir);
    refHandle = new RepoHandle(dir);
  }
  return refHandle;
}

after(() => {
  for (const dir of built) fs.rmSync(dir, { recursive: true, force: true });
});

test('buildLanes：只保留选中的轨道，父分支不会指向被筛掉的分支', () => {
  const lanes = buildLanes(refRepo(), REF_REPO_FIXED, 'local', new Set(['master', 'dev']));
  const names = lanes.map((lane) => lane.name).sort();
  assert.deepEqual(names, ['dev', 'master'], '只应该有 master 和 dev 两条轨道');

  const present = new Set(names);
  for (const lane of lanes) {
    if (!lane.parentName) continue;
    assert.ok(
      present.has(lane.parentName),
      `${lane.name} 的父分支 ${lane.parentName} 被筛掉了，谱系里不能留下悬空引用`,
    );
  }
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
  // 节点和边只能落在剩下的轨道上，不能引用被筛掉的下标
  for (const node of filtered.nodes) {
    assert.ok(
      filtered.lanes.some((lane) => lane.lane === node.lane),
      `节点 ${node.short} 落在不存在的轨道 ${node.lane} 上`,
    );
  }
});

test('buildFileGraph：空筛选 == 不筛', () => {
  const handle = refRepo();
  const all = buildFileGraph(handle, 'src/pay.js', REF_REPO_FIXED);
  const empty = buildFileGraph(handle, 'src/pay.js', REF_REPO_FIXED, { branches: [] });
  assert.equal(empty.lanes.length, all.lanes.length);
});
