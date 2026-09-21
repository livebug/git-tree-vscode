# 数据契约

本文件冻结 `src/filegraph.ts` 必须产出的 JSON 形状。**渲染器消费的字段就是契约**——
`media/graph.js` 的版本树分支（`_renderVersionTree` → `_drawGridVT` / `_drawLanesVT` /
`_drawEdgesVT` / `_drawNodesVT`）直接读这些键，少一个就是空白或报错。

坐标系约定：`x` **不是像素**，是归一化到 `[0,1]` 的**时间**；渲染器用 `_layoutMermaid()`
把它映射成竖向的 y。所有 `x` 都由 `norm(ts) = round((ts - range.minTs) / span, 7)` 得出。

```jsonc
{
  "path": "src/app.js",          // 仓库相对路径，'/'(正斜杠)分隔
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

      // 轨道几何。注意 _drawLanesVT 优先用 versions[0].x / versions[last].x 定上下端，
      // x1/x2 只是 versions 为空时的 fallback。
      "x1": 0.0, "x2": 1.0, "forkX": null,

      // 悬停提示（_laneTooltip）与分支标签（_branchTag）用
      "tip": "…", "tipShort": "…", "tipTs": 0, "tipSubject": "…", "tipAuthor": "…",
      "startTs": 0, "ownCount": 0, "reachCount": 0,
      "forkShort": null, "forkTs": null, "parentName": "master",
      "mergedInto": [], "incoming": [], "merged": false, "nodeCount": 0
    }
  ],

  "nodes": [                     // 与 versions 同一批提交的投影（_drawNodesVT 用）
    {
      "lane": 0, "sha": "…", "short": "…", "ts": 0, "author": "…",
      "subject": "…", "kind": "commit", "status": "修改",
      "x": 0.0, "labels": []
    }
  ],

  "edges": [
    {
      "kind": "merge",           // "merge"=实线虚线箭头; "fork"=分叉虚线
      "fromLane": 1, "toLane": 0,
      "sha": "…", "short": "…", "subject": "…",
      "x1": 0.0,                 // 源端归一化时间
      "x2": 0.0,                 // "merge" 时是那个 merge 提交的时间; "fork" 时同 x1
      "targetVersion": {         // 仅 "merge"：目标分支上第一个 ts >= x2 的版本
        "lane": 0, "sha": "…", "short": "…", "n": 1, "ts": 0
      }                          // 为 null 时渲染成空心圈（该分支没改过这个文件，只是继承）
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
  "stats": { "commits": 0, "lanes": 0, "tags": 0, "branches": 0 }
}
```

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
