# 数据契约

本文件冻结 `src/filegraph.ts` 必须产出的 JSON 形状。**渲染器消费的字段就是契约**——
`media/graph.js` 的版本树分支（`_renderVersionTree` → `_drawGridVT` / `_drawLanesVT` /
`_drawEdgesVT` / `_drawNodesVT`）直接读这些键，少一个就是空白或报错。

坐标系约定：`x` **不是像素**，是归一化到 `[0,1]` 的**时间**；渲染器用 `_layoutMermaid()`
把它映射成竖向的 y。所有 `x` 都由 `norm(ts) = round((ts - range.minTs) / span, 7)` 得出。

## 一条轨道上有两种节点

| kind | 含义 | 点它干什么 |
| --- | --- | --- |
| `version` | 这条分支**自己改了这个文件**的提交，编号 `/<分支名>/<n>` | `git diff <提交>^1 <提交> -- <文件>`：这个版本改了什么 |
| `merge` | 把别的轨道的改动**带进这条分支**的那次合并（"a 合并到 b"里 b 上的那个点） | `git diff <合并提交>^1 <合并提交> -- <文件>`：**这条分支上**这个文件合并前后的对比 |

合并节点必须满足：它的第一父在这条分支自己的线上。否则“合并前 vs 合并后”就不是本分支
上的前后对比了（`test/branchview.test.ts` 里锁死了这一条）。
按住 Alt 点合并节点 = 去看改动**源头**那个版本自己的 diff（`node.via.sha`）。

## 边：接力，不横穿

`edges` 只有两种，且刻意画得很少：

- `merge`：从**源端节点**（版本节点，或上一层轨道上的合并节点）指向**接收方的合并节点**。
  一趟 `fb → uat → release → master` 的传播会画成 3 根**相邻轨道之间**的短箭头，
  而不是从 fb 那个版本顶着 3 根横穿全图的长线。源端优先认“最近一次交接”。
- `fork`：分支点。**每条轨道最多一根**，横着连到它的父分支轨道上，画在分叉行。
  以前是“每个版本 × 每条继承它的轨道”各拉一根，图上一半的线都是那么来的。

```jsonc
{
  "path": "src/app.js",          // 仓库相对路径，'/'(正斜杠)分隔
  "scope": "local",             // 本图看的是哪个范围的分支："local" | "remote" | "all"
  "follow": false,
  "lanes": [
    {
      "name": "dev",
      "lane": 0,                 // 轨道序号，0 在最左
      "kind": "fixed",           // "fixed" | "other"
      "color": "#f76b15",        // 由 _color(lane, kind) 决定，见 src/lineage.ts
      "remote": false,
      "role": "author",          // "author"=真改过这个文件; "carrier"=只是继承(虚线淡显)

      "versions": [              // 该轨道上，真正改动过这个文件的提交，按时间升序
        {
          "n": 1,                // 版本号，ClearCase 语义：/<分支名>/<n>
          "sha": "…", "short": "…",
          "ts": 1788220800,      // 秒
          "subject": "…", "author": "…",
          "status": "修改",       // _statusText()：新增/修改/删除/重命名/复制/类型变更/""
          "labels": ["LBL_A"],   // tag 名，渲染成琥珀色小标签
          "x": 0.0               // 归一化时间
        }
      ],

      "mergeCount": 2,           // 本轨道上的合并节点个数（_laneSub 显示“N 个版本 · M 次合并”）

      // 轨道上下端（归一化时间）：**含版本节点和合并节点**。_drawLanesVT 直接用这两个值，
      // 不再看 versions[0]/versions[last]。两者都是数字，且 x2 >= x1。
      "x1": 0.0, "x2": 1.0, "forkX": null,

      // 悬停提示（_laneTooltip）与分支标签（_branchTag）用
      "tip": "…", "tipShort": "…", "tipTs": 0, "tipSubject": "…", "tipAuthor": "…",
      "startTs": 0, "ownCount": 0, "reachCount": 0,
      "forkShort": null, "forkTs": null, "parentName": "master",
      "mergedInto": [], "incoming": [], "merged": false, "nodeCount": 0
    }
  ],

  "nodes": [                     // _drawNodesVT 用；同一条轨道的节点按时间排
    {
      "lane": 0, "sha": "…", "short": "…", "ts": 0, "author": "…", "subject": "…",
      "kind": "version",         // "version" | "merge"
      "n": 2,                    // 版本号；"merge" 节点为 null
      "status": "修改",
      "x": 0.0, "labels": [],
      "via": null                // 仅 "merge" 节点：从哪条轨道的哪个节点带进来的
                                 // { lane, name, sha, short, kind, n }；null 时标签显示“← 合并”
    }
  ],

  "edges": [
    {
      "kind": "merge",           // "merge"=接力箭头; "fork"=分支点横线
      "fromLane": 1, "toLane": 0,
      "fromSha": "…",            // 源端节点的 sha（版本节点或上一层合并节点）
      "fromKind": "version",     // "version" | "merge" | "fork"
      "fromN": 2,                // 源端是版本节点时的 /分支/n；否则 null（tooltip 用）
      "sha": "…",                // "merge" 边=那次合并；"fork" 边=分叉点提交
      "short": "…", "subject": "…", "author": "…",
      "x1": 0.0,                 // 源端归一化时间
      "x2": 0.0,                 // 目标端归一化时间（"fork" 与 x1 相同）
      "targetNode": {            // 仅 "merge"：目标轨道上的合并节点，箭头停在它外缘
        "lane": 0, "sha": "…", "short": "…", "kind": "merge", "ts": 0, "n": null
      }                          // "fork" 时为 null
    }
  ],

  "commits": [                   // 提交表（非版本树必须，但保持同形状便于将来加表格视图）
    { "sha": "…", "short": "…", "ts": 0, "author": "…", "subject": "…",
      "parents": [], "changes": [ { "status": "M", "path": "…" } ],
      "status": "修改", "labels": [],
      "containing": ["dev"], "origin": "dev", "promotion": [] }
  ],

  "range": { "minTs": 0, "maxTs": 1 },   // norm() 的基准
  "warnings": [],                        // 前端 renderWarnings 直接显示
  "stats": { "commits": 0, "lanes": 0, "tags": 0, "branches": 0, "versions": 0, "merges": 0 }
}
```

## 分支范围（scope）

`scope` 决定 `buildLanes()` 从哪批 ref 里建轨道（`src/repo.ts` 的 `selectRefs`）：

| scope | 取哪些 ref | 说明 |
| --- | --- | --- |
| `local` | `refs/heads/*` | 默认 |
| `remote` | `refs/remotes/*` | 只看远端仓库；分支名带 remote 前缀（`origin/dev`） |
| `all` | 两者 | 本地优先；**远端的本地镜像会被去掉一份**（本地有 `dev` 就不再画 `origin/dev`），远端独有的分支仍然保留 |

固定分支名（`gitTree.fixedBranches`）与 refs 的匹配：先精确同名，再按 `branchPart()`
（`origin/dev` → `dev`）匹配远端轨道。所以同一份配置在三种范围下都成立。

## 主题变量

`media/graph.js` 的 `readTheme()` 读 `document.body` 上的 computed style，只认这 5 个：

| 变量 | webview 里的来源 |
| --- | --- |
| `--fg` | `--vscode-editor-foreground` |
| `--fg-muted` | `--vscode-descriptionForeground` |
| `--border` | `--vscode-panel-border`，缺失回退 `--vscode-editorWidget-border` |
| `--plot-bg` | `--vscode-editor-background` |
| `--grid` | `--vscode-editorIndentGuide-background` |

**SVG 表现属性不支持 `var()`**，所以这几个变量必须能解析出具体色值——`theme.css` 里把
`--vscode-*` 赋给它们即可，`readTheme()` 会自动解析。

分支颜色不走 CSS：`lane.color` 由后端（这里是 `src/lineage.ts` 的 `_color`）给出。
