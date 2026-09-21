# git-tree-vscode

VS Code 插件：在资源管理器里**右键一个文件 → 查看版本树**，用 ClearCase 的版本树视角
看这个文件的改动历史。

```
/master      /dev              /release            ← 一条轨道 = 一个分支
   │            ●1 拆分鉴权       ●1 初始版本  [LBL_BASE]
   │             │  ⋱             │
   │             ●2 增加限流       ●2 修安全头  [LBL_REL1]
   │             ↑┈┈┈┈┈┈虚线箭头┈┈┈┈┈┈╯
   ○┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈╯   （○ = 该分支只是继承了这个改动，自己没改过）
```

- 方块里的数字是版本号（ClearCase 语义：`/<分支名>/<n>`）
- 琥珀色小标签是 git tag（对应 ClearCase 的 `LBL_*`）
- 虚线箭头 = 这次合并把这个改动带进了目标分支，箭头落在**目标分支上第一个包含它的版本**
- 浅色虚线轨道 = 这条分支只是继承了这个改动，自己没改过

## 与 git-tree 的关系

**零耦合。** 本项目是一个独立仓库、独立的 npm 包，不引用 `git-tree` 的任何代码，
运行和测试都不需要 Python。算法是那套规则的 TypeScript 移植，规则说明见
[`git-tree/DEVELOPMENT.md`](../git-tree/DEVELOPMENT.md) 第 4 节。

一次性拷贝来的东西只有一个：

| 文件 | 来源 | 说明 |
| --- | --- | --- |
| `media/graph.js` | `git-tree/frontend/graph.js` @ `997446c` | 渲染器整份拷贝，之后**由本项目自行维护**；上游后续修复不会自动流进来 |

`media/graph.js` 只被用了版本树那条路径；三个分支图风格（lanes / mermaid / mermaid-lr）
作为可选性一起留着了——将来想在同一面板里加分支图视图，直接能用。

## 开发

```bash
npm install
npm run compile      # tsc → out/
npm test             # 纯 Node，不需要 Python，不需要下载 Electron
```

调试：在 VS Code 里按 `F5` 起 Extension Development Host，然后在那个窗口里
右键任意文件 → 「查看版本树」。

> 目标目录如果在别的工作区之外，需要把它加进 VS Code 工作区（或单开一个窗口）。

## 打包与内网安装

```bash
npm install
npm run vsix                # → git-tree-vscode-0.1.0.vsix
```

内网机器（不需要网络、不需要 npm）：

```bash
code --install-extension git-tree-vscode-0.1.0.vsix
```

也可以直接在扩展面板右上角「…」→「从 VSIX 安装」。

## 发版

改完 `package.json` 里的 `version`，提交后打个同名 tag 即可：

```bash
npm version patch --no-git-tag-version    # 或者手改 version
git commit -am "chore: release v0.1.1"
git tag v0.1.1
git push && git push origin v0.1.1
```

[`.github/workflows/release.yml`](.github/workflows/release.yml) 会校验 tag 与
`package.json` 版本一致，然后跑测试、打 vsix、发 GitHub Release 并把 vsix 挂成附件。
之后从 <https://github.com/livebug/git-tree-vscode/releases> 下载即可。
也可以在 Actions 页面手动触发（`workflow_dispatch`），会用当前 `package.json` 版本发一版。

## 设置

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `gitTree.fixedBranches` | `[]` | 固定分支（发布层级），**顺序即层级**，越靠前越底层。留空则自动识别。 |
| `gitTree.autoFixed` | `true` | 自动识别固定分支。 |
| `gitTree.fixedPrefixes` | `["release"]` | 自动识别时，以这些前缀开头的分支也算固定分支——这样 `release` 能认出 `release20260919`。 |
| `gitTree.maxCommits` | `40000` | `git log --all` 的上限。 |
| `gitTree.includeRemotes` | `false` | 把 `origin/*` 也画进来。 |
| `gitTree.follow` | `false` | 跟随文件重命名（`git log --follow`）。 |
| `gitTree.gitPath` | `git` | git 可执行文件路径。 |

**固定分支一定要配对。** 没有固定分支就没有"承载轨道"——改动往上传播的路径会整片消失，
版本树只剩下一半信息。插件在没有识别出固定分支时会在面板上方给出提示。

自动识别是**建议性**的：它按 `master / dev / uat / release …` 的习惯挑，加前缀匹配认得
出带日期的发版分支。如果你们的层级不一样，老老实实配 `gitTree.fixedBranches`。

## 结构

```
src/git.ts        git 命令封装。慢命令（log --all / log --name-status）走异步——
                  扩展宿主是所有扩展共享的一个进程，spawnSync 会把它整个卡住。
src/gitstore.ts   提交 DAG：稠密整数索引的平行数组
src/lineage.ts    谱系推断：分叉点、父分支、own —— 规则的实现
src/filegraph.ts  单文件历史 → 版本树数据（产出 CONTRACT.md 里那份契约）
src/fixed.ts      固定分支的自动识别
src/repo.ts       仓库句柄：refs / tags / 单文件历史 + 缓存
src/panel.ts      webview 面板（CSP、主题、复用同一个面板）
src/diffs.ts      vscode.diff 的原生差异视图
media/graph.js    渲染器（拷来的，见上）
media/theme.css   --vscode-* → graph.js 认识的那 5 个 CSS 变量
media/main.js     胶水层：初始化渲染器、收 payload、把点击回抛给扩展
test/             规则断言 + 回归场景
```

## 正确性

本项目**不做**与 Python 实现的持续比对（那是刻意解耦的代价），替代方案是把规则写成断言：

- `test/rules.test.ts` —— 把 `DEVELOPMENT.md` §4 的规则逐条写成可执行检查
- `test/regression.test.ts` —— 记录下来的"真的算错过"的场景

期望值不是手推的：`test/fixtures.ts` 里的 REF 拓扑先在两个实现上跑过一次交叉验证
（14 个分支的 parent / own / reach / kind 全部一致）之后才抄进断言。

## 已知边界

- **只做单文件版本树**，不做分支图（那是 `git-tree` 网页版的活）。
- 规则 5/6（`mergedInto`、合并边）属于分支图，本扩展未实现。
- `parentName` / `forkX` 只服务悬停提示，不影响图形；省掉它们会让一致性变差，所以留着。
- 把冲突分支合回它自己的来源分支，会让来源分支反过来认它当爹（与参考实现一致，
  见 `test/regression.test.ts` 的怪癖测试）。实际流程不会这么干，但值得知道。
