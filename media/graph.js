/* git-tree SVG renderer — no dependencies.
 *
 * 来源：git-tree/frontend/graph.js（一次性拷贝，之后由本项目自行维护）
 *   commit  997446c8b9b61520e516dffec749818f59ceefab  (997446c 2026-09-19)
 *   sha256  82e60e81a13dcd926d43531827b58898c919ad4b3015d17fb8d0676e7c199d4e
 *
 * 本项目与 git-tree 零耦合：上游后来对版本树渲染的修复**不会**自动流进来。
 * 要改渲染只在本文件里改；若哪天想合并上游，得手工比对。
 *
 * 对外接口（末尾导出）：global.GitTreeGraph = { Renderer, GUTTER, LANE_H, fmtDate, fmtDateShort }
 * 主题靠 readTheme() 读 body 上的 5 个 CSS 变量：--grid --plot-bg --fg --fg-muted --border
 *   （webview 里由 media/theme.css 映射到 --vscode-*，见 CONTRACT.md）
 */
(function (global) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var LANE_H = 46;
  var GUTTER = 214;
  var PAD_TOP = 40;
  var PAD_BOTTOM = 56;
  var DAY = 86400;
  var MIN_PLOT = 1200;
  var MAX_PLOT = 14000;

  // mermaid-gitGraph style (vertical time axis, one column per branch)
  var M_COL_W = 78;         // horizontal distance between branch lines
  var M_PAD_LEFT = 70;      // room for the branch tag of the first column
  var M_PAD_RIGHT = 96;     // room for the right-hand date axis
  var M_PAD_TOP = 66;       // room for the branch tags at the top
  var M_PAD_BOTTOM = 40;
  var M_ROW_MAX = 40;       // row pitch when the graph is small
  var M_ROW_MIN = 11;       // row pitch when the graph is huge
  var M_HEADER_H = 44;      // screen-space lane header
  var M_ROW_H_MIN = 22;     // rows must be this far apart on screen for commit labels
  var M_FONT_MIN = 0.78;    // ...and the labels themselves must be readable
  var M_TAG_COL_W = 40;     // hide the branch tags once the columns get this narrow

  // mermaid gitGraph LR (mermaid's default orientation): one row per branch,
  // time flows to the right, commit labels are rotated like mermaid does.
  var LR_CORNER = 11;       // rounded elbow between a branch row and its drop/rise
  var LR_LABEL_H = 92;      // longest rotated commit label (content px)
  var STYLES = ['lanes', 'mermaid-lr', 'mermaid'];
  var DEFAULT_STYLE = 'lanes';   // 泳道时间轴：分支/合并分得最清楚，作为默认

  // ClearCase style version tree (single file history): one track per branch,
  // versions are numbered boxes, merges are dotted arrows between versions.
  var VT_COL_W = 196;
  var VT_BOX = 22;
  var VT_TEXT_W = 124;
  var VT_PAD_LEFT = 92;
  var VT_PAD_RIGHT = 104;
  var VT_PAD_TOP = 70;
  var VT_PAD_BOTTOM = 46;

  var _measureCtx = null;
  function textWidth(text, font) {
    if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d');
    _measureCtx.font = font;
    return _measureCtx.measureText(text).width;
  }

  function truncateToWidth(text, font, maxWidth) {
    text = String(text || '');
    if (!text || textWidth(text, font) <= maxWidth) return text;
    var lo = 0, hi = text.length;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (textWidth(text.slice(0, mid) + '\u2026', font) <= maxWidth) lo = mid; else hi = mid - 1;
    }
    return text.slice(0, lo) + '\u2026';
  }

  function fmtSpan(spanSec) {
    if (spanSec >= 2 * DAY) return (spanSec / DAY).toFixed(0) + ' \u5929';
    return (spanSec / 3600).toFixed(1) + ' \u5c0f\u65f6';
  }

  function el(tag, attrs) {
    var node = document.createElementNS(NS, tag);
    if (attrs) {
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k) && attrs[k] !== null && attrs[k] !== undefined) {
          node.setAttribute(k, String(attrs[k]));
        }
      }
    }
    return node;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  var FONT_MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
  var FONT_UI = "'Segoe UI', system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";

  /** Presentation attributes cannot contain var(), so resolve them up front. */
  function readTheme() {
    var cs = getComputedStyle(document.body);
    function v(name, fb) {
      var value = cs.getPropertyValue(name).trim();
      return value || fb;
    }
    return {
      grid: v('--grid', 'rgba(0,0,0,0.06)'),
      plotBg: v('--plot-bg', '#ffffff'),
      fg: v('--fg', '#1b1f27'),
      fgMuted: v('--fg-muted', '#6b7280'),
      border: v('--border', '#d9dde5')
    };
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function fmtDate(ts, withTime) {
    var d = new Date(ts * 1000);
    var s = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    if (withTime) s += ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    return s;
  }

  function fmtDateShort(ts) {
    var d = new Date(ts * 1000);
    return d.getFullYear() + '/' + pad2(d.getMonth() + 1) + '/' + pad2(d.getDate());
  }

  function niceStep(spanSec, targetTicks) {
    var candidates = [DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 60 * DAY, 91 * DAY, 182 * DAY, 365 * DAY, 730 * DAY, 1825 * DAY];
    for (var i = 0; i < candidates.length; i++) {
      if (spanSec / candidates[i] <= targetTicks) return candidates[i];
    }
    return candidates[candidates.length - 1];
  }

  function Renderer(svg, options) {
    this.svg = svg;
    this.options = options || {};
    this.onNodeClick = this.options.onNodeClick || function () {};
    this.onLaneClick = this.options.onLaneClick || function () {};
    this.payload = null;
    this.mode = 'branch';
    this.k = 1;
    this.tx = 0;
    this.ty = 0;
    this.showAxis = true;
    this.showLabels = true;
    this.showSubjects = true;
    this.style = STYLES.indexOf(this.options.style) >= 0 ? this.options.style : DEFAULT_STYLE;
    this.fileStyle = this.options.fileStyle === 'tree' ? 'tree' : 'lanes';
    this.theme = readTheme();
    this._bind();
  }

  /** The renderer actually in use: the file view may override the graph style. */
  Renderer.prototype._vstyle = function () {
    if (this.mode === 'file' && this.fileStyle === 'tree') return 'version-tree';
    return this.style;
  };

  Renderer.prototype.setFileStyle = function (style) {
    var next = style === 'tree' ? 'tree' : 'lanes';
    if (next === this.fileStyle) return;
    this.fileStyle = next;
    if (this.mode === 'file' && this.payload) {
      this._layout();
      this.fit();
    }
  };

  Renderer.prototype.getFileStyle = function () { return this.fileStyle; };

  Renderer.prototype.refreshTheme = function () {
    this.theme = readTheme();
    if (this.payload) this.render();
  };

  Renderer.prototype.setStyle = function (style) {
    var next = STYLES.indexOf(style) >= 0 ? style : DEFAULT_STYLE;
    if (next === this.style) return;
    this.style = next;
    this._layout();
    this.fit();
  };

  Renderer.prototype.getStyle = function () { return this.style; };

  Renderer.prototype.setShowSubjects = function (on) {
    this.showSubjects = !!on;
    if (!this.payload) return;
    if (this.style === 'mermaid') this._drawNodesM();
    else if (this.style === 'mermaid-lr') this._drawNodesLR();
  };

  Renderer.prototype._bind = function () {
    var self = this;
    var dragging = false;
    var startX = 0, startY = 0, startTx = 0, startTy = 0;

    this.svg.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      startTx = self.tx; startTy = self.ty;
      self.svg.classList.add('dragging');
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      self.tx = startTx + (e.clientX - startX);
      self.ty = startTy + (e.clientY - startY);
      self._applyTransform();
    });
    window.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      self.svg.classList.remove('dragging');
    });
    this.svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      var factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      self.zoomAt(factor, e.clientX, e.clientY);
    }, { passive: false });
  };

  Renderer.prototype.size = function () {
    var rect = this.svg.getBoundingClientRect();
    return { w: Math.max(320, rect.width), h: Math.max(240, rect.height) };
  };

  Renderer.prototype.setData = function (payload, mode) {
    this.payload = payload || null;
    this.mode = mode || 'branch';
    this._layout();
    this.fit();
  };

  Renderer.prototype._layout = function () {
    var p = this.payload;
    this.lanes = (p && p.lanes) || [];
    this.nodes = (p && p.nodes) || [];
    this.edges = (p && p.edges) || [];
    this.range = (p && p.range) || { minTs: 0, maxTs: 0 };

    this.laneCount = this.lanes.length;
    this.laneById = {};
    for (var i = 0; i < this.lanes.length; i++) this.laneById[this.lanes[i].lane] = this.lanes[i];

    if (this._vstyle() === 'mermaid') this._layoutMermaid(M_COL_W);
    else if (this._vstyle() === 'version-tree') this._layoutMermaid(VT_COL_W, VT_PAD_LEFT, VT_PAD_RIGHT, VT_PAD_TOP, VT_PAD_BOTTOM);
    else this._layoutLanes();
  };

  // one column per branch, time flows downwards (mermaid gitGraph look)
  Renderer.prototype._layoutMermaid = function (colW, padLeft, padRight, padTop, padBottom) {
    colW = colW || M_COL_W;
    padLeft = padLeft === undefined ? M_PAD_LEFT : padLeft;
    padRight = padRight === undefined ? M_PAD_RIGHT : padRight;
    padTop = padTop === undefined ? M_PAD_TOP : padTop;
    padBottom = padBottom === undefined ? M_PAD_BOTTOM : padBottom;
    var keys = {};
    function add(v) {
      if (v === null || v === undefined || isNaN(v)) return;
      keys[Math.round(v * 1e6)] = true;
    }
    for (var i = 0; i < this.nodes.length; i++) add(this.nodes[i].x);
    for (var j = 0; j < this.lanes.length; j++) { add(this.lanes[j].x1); add(this.lanes[j].x2); }
    for (var m = 0; m < this.edges.length; m++) { add(this.edges[m].x1); add(this.edges[m].x2); }

    this.rowKeys = Object.keys(keys).map(Number).sort(function (a, b) { return a - b; });
    this.rowCount = this.rowKeys.length;
    this.rowH = clamp(Math.round(40000 / Math.max(1, this.rowCount)), M_ROW_MIN, M_ROW_MAX);
    this.colW = colW;
    this.contentWidth = padLeft + Math.max(1, this.laneCount) * colW + padRight;
    this.contentHeight = padTop + this.rowCount * this.rowH + padBottom;
    this.padLeft = padLeft;
    this.padTop = padTop;
    this.plotWidth = this.contentWidth;
    this.totalWidth = this.contentWidth;
  };

  /** Fractional row index of a normalised time (0..1). */
  Renderer.prototype._rowPos = function (v) {
    var keys = this.rowKeys;
    if (!keys || !keys.length) return 0;
    var want = (v || 0) * 1e6;
    var lo = 0, hi = keys.length - 1;
    if (want <= keys[0]) return 0;
    if (want >= keys[hi]) return hi;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (keys[mid] <= want) lo = mid; else hi = mid;
    }
    if (keys[lo] === want) return lo;
    if (keys[hi] === want) return hi;
    return lo + (want - keys[lo]) / (keys[hi] - keys[lo]);
  };

  /** Normalise a raw timestamp the same way the backend does. */
  Renderer.prototype.normOf = function (ts) {
    var span = Math.max(1, this.range.maxTs - this.range.minTs);
    return ((ts || 0) - this.range.minTs) / span;
  };

  Renderer.prototype.mX = function (lane) { return (this.padLeft === undefined ? M_PAD_LEFT : this.padLeft) + (lane || 0) * this.colW; };  Renderer.prototype.mY = function (normX) { return (this.padTop === undefined ? M_PAD_TOP : this.padTop) + this._rowPos(normX) * this.rowH; };

  /** Content-space anchor of a lane, used to scroll a branch into view. */
  Renderer.prototype.laneAnchor = function (lane) {
    if (!lane) return { x: 0, y: 0 };
    if (this._vstyle() === 'mermaid' || this._vstyle() === 'version-tree') {
      return { x: this.mX(lane.lane), y: this.mY(lane.x2) };
    }
    return { x: this.xPx(lane.x2), y: this.laneY(lane.lane) };
  };

  Renderer.prototype.centerOn = function (x, y) {
    var s = this.size();
    this.tx = s.w / 2 - this.k * x;
    this.ty = s.h / 2 - this.k * y;
    this._applyTransform();
  };

  Renderer.prototype._layoutLanes = function () {
    var spanDays = (this.range.maxTs - this.range.minTs) / DAY;
    var byTime = spanDays * 30;
    var byCount = (this.nodes.length / Math.max(1, this.laneCount)) * 11;
    var byLane = this.laneCount * 95;
    this.plotWidth = clamp(Math.max(byTime, byCount, byLane, MIN_PLOT), MIN_PLOT, MAX_PLOT);
    this.contentHeight = PAD_TOP + this.laneCount * LANE_H + PAD_BOTTOM;
    this.totalWidth = GUTTER + this.plotWidth;
    this.rowH = LANE_H;   // row pitch, used by the commit label gate
    this.colW = 0;
  };

  Renderer.prototype.xPx = function (x) { return GUTTER + (x || 0) * this.plotWidth; };
  Renderer.prototype.laneY = function (lane) { return PAD_TOP + lane * LANE_H + LANE_H / 2; };

  Renderer.prototype.fit = function () {
    var s = this.size();
    var vstyle = this._vstyle();
    if (vstyle === 'mermaid' || vstyle === 'version-tree') {
      var mx = (s.w - 24) / Math.max(1, this.contentWidth);
      var my = (s.h - M_HEADER_H - 24) / Math.max(1, this.contentHeight);
      // very long histories keep a readable row pitch and scroll instead of collapsing
      this.k = clamp(Math.min(1, mx, Math.max(my, 0.3)), 0.05, 1);
      this.tx = Math.max(16, (s.w - this.k * this.contentWidth) / 2);
      this.ty = M_HEADER_H + 8;
      this.render();
      return;
    }
    var kx = (s.w - GUTTER - 16) / Math.max(1, this.plotWidth);
    var ky = (s.h - 90) / Math.max(1, this.contentHeight);
    // never shrink below a readable size -- the user can pan instead
    this.k = clamp(Math.min(1, kx, ky), 0.12, 1);
    this.tx = 0;
    this.ty = clamp((s.h - 70 - this.k * this.contentHeight) / 2, 0, 600);
    this.render();
  };

  Renderer.prototype.reset = function () {
    var vstyle = this._vstyle();
    this.k = 1;
    this.tx = (vstyle === 'mermaid' || vstyle === 'version-tree') ? 16 : 0;
    this.ty = (vstyle === 'mermaid' || vstyle === 'version-tree') ? M_HEADER_H + 8 : 0;
    this.render();
  };

  Renderer.prototype.zoomBy = function (factor) {
    var s = this.size();
    this.zoomAt(factor, s.w / 2, s.h / 2);
  };

  Renderer.prototype.zoomAt = function (factor, clientX, clientY) {
    if (!this.payload) return;
    var rect = this.svg.getBoundingClientRect();
    var px = clientX - rect.left;
    var py = clientY - rect.top;
    var nk = clamp(this.k * factor, 0.05, 6);
    if (nk === this.k) return;
    this.tx = px - (px - this.tx) * (nk / this.k);
    this.ty = py - (py - this.ty) * (nk / this.k);
    this.k = nk;
    this._applyTransform();
  };

  Renderer.prototype._applyTransform = function () {
    if (!this.root) return;
    var vstyle = this._vstyle();
    this.root.setAttribute('transform', 'translate(' + this.tx + ',' + this.ty + ') scale(' + this.k + ')');
    if (vstyle === 'mermaid') {
      // commit subjects and branch tags only kick in once things are readable
      var wantText = this._wantText();
      var wantTags = this.k * this.colW >= M_TAG_COL_W;
      if (wantText !== this._textOn || wantTags !== this._tagsOn) {
        this._drawLanesM();
        this._drawNodesM();
      }
    } else if (vstyle === 'mermaid-lr') {
      if (this._wantText() !== this._textOn) this._drawNodesLR();
    }
    this._drawLabels();
    this._drawAxis();
  };

  Renderer.prototype.setShowAxis = function (on) { this.showAxis = !!on; this._drawAxis(); };
  Renderer.prototype.setShowLabels = function (on) { this.showLabels = !!on; this._drawLabels(); };

  // ------------------------------------------------------------------
  // main render
  // ------------------------------------------------------------------
  /** Shared <defs>: plot clip + soft glow used by commit dots. */
  Renderer.prototype._buildDefs = function (clipX, clipW) {
    var s = this.size();
    var defs = el('defs');
    var clip = el('clipPath', { id: 'plotClip', clipPathUnits: 'userSpaceOnUse' });
    this._clipRect = el('rect', { x: clipX, y: 0, width: Math.max(0, clipW), height: s.h });
    clip.appendChild(this._clipRect);
    defs.appendChild(clip);
    var glow = el('filter', { id: 'softGlow', x: '-60%', y: '-60%', width: '220%', height: '220%' });
    glow.appendChild(el('feGaussianBlur', { stdDeviation: 2.6, result: 'b' }));
    var merge = el('feMerge');
    merge.appendChild(el('feMergeNode', { in: 'b' }));
    merge.appendChild(el('feMergeNode', { in: 'SourceGraphic' }));
    glow.appendChild(merge);
    defs.appendChild(glow);
    this.svg.appendChild(defs);
  };

  Renderer.prototype.render = function () {
    var vstyle = this._vstyle();
    if (vstyle === 'version-tree') return this._renderVersionTree();
    if (vstyle === 'mermaid') return this._renderMermaid();
    if (vstyle === 'mermaid-lr') return this._renderMermaidLR();
    return this._renderLanes();
  };

  /** mermaid gitGraph LR: branch rows, time to the right, rotated commit labels. */
  Renderer.prototype._renderMermaidLR = function () {
    this.theme = readTheme();
    var s = this.size();
    this.svg.setAttribute('viewBox', '0 0 ' + s.w + ' ' + s.h);
    this.svg.innerHTML = '';
    this._buildDefs(GUTTER, s.w - GUTTER);

    var plot = el('g', { 'clip-path': 'url(#plotClip)' });
    this.root = el('g');
    this.grid = el('g');
    this.guideLayer = el('g');
    this.laneLayer = el('g');
    this.edgeLayer = el('g');
    this.mLabelLayer = el('g');
    this.nodeLayer = el('g');
    this.root.appendChild(this.grid);
    this.root.appendChild(this.guideLayer);
    this.root.appendChild(this.laneLayer);
    this.root.appendChild(this.edgeLayer);
    this.root.appendChild(this.mLabelLayer);
    this.root.appendChild(this.nodeLayer);
    plot.appendChild(this.root);
    this.svg.appendChild(plot);

    this.labelLayer = el('g');
    this.svg.appendChild(this.labelLayer);
    this.axisLayer = el('g');
    this.svg.appendChild(this.axisLayer);

    this._textOn = null;
    this._drawGrid();
    this._drawGuidesLR();
    this._drawLanesLR();
    this._drawEdgesLR();
    this._drawNodesLR();
    this._applyTransform();
  };

  /** Vertical mermaid-gitGraph style: branch columns, time downwards. */
  Renderer.prototype._renderMermaid = function () {
    this.theme = readTheme();
    var s = this.size();
    this.svg.setAttribute('viewBox', '0 0 ' + s.w + ' ' + s.h);
    this.svg.innerHTML = '';
    this._buildDefs(0, s.w);

    var plot = el('g', { 'clip-path': 'url(#plotClip)' });
    this.root = el('g');
    this.grid = el('g');
    this.laneLayer = el('g');
    this.edgeLayer = el('g');
    this.mLabelLayer = el('g');
    this.nodeLayer = el('g');
    this.root.appendChild(this.grid);
    this.root.appendChild(this.laneLayer);
    this.root.appendChild(this.edgeLayer);
    this.root.appendChild(this.mLabelLayer);
    this.root.appendChild(this.nodeLayer);
    plot.appendChild(this.root);
    this.svg.appendChild(plot);

    this.labelLayer = el('g');
    this.svg.appendChild(this.labelLayer);
    this.axisLayer = el('g');
    this.svg.appendChild(this.axisLayer);

    this._textOn = null;
    this._tagsOn = null;
    this._drawGridM();
    this._drawLanesM();
    this._drawEdgesM();
    this._drawNodesM();
    this._applyTransform();
  };

  Renderer.prototype._renderLanes = function () {
    this.theme = readTheme();
    var s = this.size();
    this.svg.setAttribute('viewBox', '0 0 ' + s.w + ' ' + s.h);
    this.svg.innerHTML = '';
    this._buildDefs(GUTTER, s.w - GUTTER);

    var plot = el('g', { 'clip-path': 'url(#plotClip)' });
    this.root = el('g');
    this.grid = el('g');
    this.edgeLayer = el('g');
    this.laneLayer = el('g');
    this.nodeLayer = el('g');
    this.root.appendChild(this.grid);
    this.root.appendChild(this.laneLayer);
    this.root.appendChild(this.edgeLayer);
    this.root.appendChild(this.nodeLayer);
    plot.appendChild(this.root);
    this.svg.appendChild(plot);

    this.labelLayer = el('g');
    this.svg.appendChild(this.labelLayer);
    this.axisLayer = el('g');
    this.svg.appendChild(this.axisLayer);

    this._drawGrid();
    this._drawLanes();
    this._drawEdges();
    this._drawNodes();
    this._applyTransform();
  };

  Renderer.prototype._ticks = function () {
    var min = this.range.minTs, max = this.range.maxTs;
    if (!min || !max || max <= min) return [];
    var step = niceStep(max - min, 12);
    var ticks = [];
    var t = Math.ceil(min / step) * step;
    var guard = 0;
    while (t <= max && guard < 200) {
      ticks.push(t);
      t += step;
      guard++;
    }
    return ticks;
  };

  Renderer.prototype._drawGrid = function () {
    if (!this.grid) return;
    this.grid.innerHTML = '';
    var ticks = this._ticks();
    for (var i = 0; i < ticks.length; i++) {
      var x = this.xPx((ticks[i] - this.range.minTs) / Math.max(1, this.range.maxTs - this.range.minTs));
      this.grid.appendChild(el('line', {
        x1: x, y1: PAD_TOP - 16, x2: x, y2: PAD_TOP + this.laneCount * LANE_H + 6,
        stroke: this.theme.grid, 'stroke-width': 1
      }));
    }
  };

  Renderer.prototype._drawLanes = function () {
    if (!this.laneLayer) return;
    var self = this;
    this.laneLayer.innerHTML = '';
    for (var i = 0; i < this.lanes.length; i++) {
      (function (lane) {
        var y = self.laneY(lane.lane);
        var x1 = self.xPx(lane.x1);
        var x2 = Math.max(self.xPx(lane.x2), x1 + 8);
        var g = el('g', { 'data-lane': lane.lane });

        var band = el('rect', {
          x: 0, y: y - LANE_H / 2, width: self.totalWidth, height: LANE_H,
          fill: lane.lane % 2 === 0 ? 'rgba(127,127,127,0.045)' : 'transparent'
        });
        g.appendChild(band);

        g.appendChild(el('line', {
          x1: x1, y1: y, x2: x2, y2: y,
          stroke: lane.color, 'stroke-width': 10, 'stroke-linecap': 'round', opacity: 0.16
        }));
        g.appendChild(el('line', {
          x1: x1, y1: y, x2: x2, y2: y,
          stroke: lane.color, 'stroke-width': 2.6, 'stroke-linecap': 'round', opacity: 0.92
        }));

        if (lane.role === 'carrier') {
          // this branch only inherited the change, it did not author it
          g.setAttribute('opacity', '0.55');
          g.appendChild(el('line', {
            x1: x1, y1: y, x2: x2, y2: y,
            stroke: lane.color, 'stroke-width': 2.6, 'stroke-linecap': 'round',
            'stroke-dasharray': '7 6', opacity: 0.9
          }));
        }

        if (lane.merged) {
          g.appendChild(el('circle', {
            cx: x2, cy: y, r: 5.5, fill: 'none', stroke: lane.color, 'stroke-width': 2, opacity: 0.75
          }));
        } else {
          g.appendChild(el('circle', {
            cx: x2, cy: y, r: 5, fill: lane.color, stroke: self.theme.plotBg, 'stroke-width': 1.6
          }));
        }

        var title = el('title');
        title.textContent = self._laneTooltip(lane);
        g.appendChild(title);
        self.laneLayer.appendChild(g);
      })(this.lanes[i]);
    }
  };

  Renderer.prototype._laneTooltip = function (lane) {
    var lines = [];
    lines.push(lane.name + (lane.kind === 'fixed' ? '  （固定分支）' : ''));
    if (lane.role === 'carrier') {
      lines.push('该分支包含此文件的改动（继承而来，非本分支提交）');
    }
    if (lane.role === 'author' && this.mode === 'file') {
      lines.push('本分支提交了 ' + lane.ownCount + ' 次该文件的改动');
    }
    lines.push('最新提交: ' + lane.tipShort + '  ' + fmtDate(lane.tipTs, true));
    lines.push('    ' + (lane.tipSubject || ''));
    lines.push('    ' + (lane.tipAuthor || ''));
    if (lane.parentName) lines.push('分叉自: ' + lane.parentName + (lane.forkShort ? ' @ ' + lane.forkShort : ''));
    lines.push('本分支独有提交: ' + lane.ownCount + ' 个');
    if (lane.mergedInto && lane.mergedInto.length) {
      var parts = lane.mergedInto.map(function (m) {
        return m.short ? m.intoBranch + ' @ ' + m.short : m.intoBranch + '（经其它分支带入）';
      });
      lines.push('已合并到: ' + parts.join('、'));
    } else if (lane.kind !== 'fixed') {
      lines.push('尚未合并到任何固定分支');
    }
    return lines.join('\n');
  };

  Renderer.prototype._drawEdges = function () {
    if (!this.edgeLayer) return;
    this.edgeLayer.innerHTML = '';
    for (var i = 0; i < this.edges.length; i++) {
      var e = this.edges[i];
      var from = this.laneById[e.fromLane];
      var to = this.laneById[e.toLane];
      if (!from || !to) continue;
      var y1 = this.laneY(from.lane);
      var y2 = this.laneY(to.lane);
      var x1 = this.xPx(e.x1);
      var x2 = this.xPx(e.x2);
      var d;
      if (e.kind === 'fork') {
        d = 'M' + x1 + ',' + y1 + ' C' + x1 + ',' + (y1 + (y2 - y1) * 0.55) + ' ' + x2 + ',' + (y2 - (y2 - y1) * 0.55) + ' ' + x2 + ',' + y2;
      } else {
        var c = Math.max((x2 - x1) * 0.45, 22);
        d = 'M' + x1 + ',' + y1 + ' C' + (x1 + c) + ',' + y1 + ' ' + (x2 - c) + ',' + y2 + ' ' + x2 + ',' + y2;
      }
      var path = el('path', {
        d: d, fill: 'none',
        stroke: to.color,
        'stroke-width': e.kind === 'merge' ? 2 : 1.6,
        'stroke-dasharray': e.kind === 'fork' ? '5 4' : null,
        opacity: e.kind === 'merge' ? 0.72 : 0.5,
        'stroke-linecap': 'round'
      });
      var t = el('title');
      var edgeTs = Math.round(e.x2 * (this.range.maxTs - this.range.minTs) + this.range.minTs);
      t.textContent = (e.kind === 'merge' ? '合并 ' : '分叉 ') + fmtDate(edgeTs, true) +
        '\n' + (to.name || '') + '  ←  ' + (from.name || '') + '\n' + e.short + '  ' + (e.subject || '');
      path.appendChild(t);
      this.edgeLayer.appendChild(path);
    }
  };

  Renderer.prototype._drawNodes = function () {
    if (!this.nodeLayer) return;
    var self = this;
    this.nodeLayer.innerHTML = '';
    for (var i = 0; i < this.nodes.length; i++) {
      (function (n) {
        var lane = self.laneById[n.lane];
        if (!lane) return;
        var y = self.laneY(n.lane);
        var x = self.xPx(n.x);
        var g = el('g', { 'class': 'node', 'data-sha': n.sha, 'data-lane': n.lane });

        var r = n.kind === 'tip' ? 6 : n.kind === 'commit' ? 3.4 : 5;
        var shape;
        if (n.kind === 'merge') {
          shape = el('path', {
            d: 'M' + x + ',' + (y - 6) + ' L' + (x + 6) + ',' + y + ' L' + x + ',' + (y + 6) + ' L' + (x - 6) + ',' + y + ' Z',
            fill: lane.color, stroke: self.theme.plotBg, 'stroke-width': 1.4
          });
        } else {
          shape = el('circle', {
            cx: x, cy: y, r: r,
            fill: n.kind === 'fork' ? self.theme.plotBg : lane.color,
            stroke: n.kind === 'fork' ? lane.color : self.theme.plotBg,
            'stroke-width': n.kind === 'fork' ? 2 : 1.4
          });
        }
        g.appendChild(shape);

        if (n.kind === 'tip') {
          g.appendChild(el('circle', { cx: x, cy: y, r: 10, fill: 'none', stroke: lane.color, 'stroke-width': 1, opacity: 0.4 }));
        }

        var t = el('title');
        t.textContent = n.short + '  ' + fmtDate(n.ts, true) + '\n' + lane.name + '\n' + (n.subject || '') + '\n' + (n.author || '') +
          (n.status ? '\n状态: ' + n.status : '');
        g.appendChild(t);

        g.addEventListener('click', function (ev) {
          ev.stopPropagation();
          self.onNodeClick(n, lane);
        });
        self.nodeLayer.appendChild(g);
      })(this.nodes[i]);
    }
  };

  // ------------------------------------------------------------------
  // mermaid style: grid / branch columns / curves / commits
  // ------------------------------------------------------------------
  Renderer.prototype._drawGridM = function () {
    if (!this.grid) return;
    this.grid.innerHTML = '';
    var span = Math.max(1, this.range.maxTs - this.range.minTs);
    var ticks = this._ticks();
    var width = this.contentWidth;
    for (var i = 0; i < ticks.length; i++) {
      var y = this.mY((ticks[i] - this.range.minTs) / span);
      this.grid.appendChild(el('line', {
        x1: 0, y1: y, x2: width, y2: y, stroke: this.theme.grid, 'stroke-width': 1
      }));
    }
  };

  Renderer.prototype._drawLanesM = function () {
    if (!this.laneLayer) return;
    var self = this;
    var showTags = this.k * this.colW >= M_TAG_COL_W;
    this._tagsOn = showTags;
    this.laneLayer.innerHTML = '';
    for (var i = 0; i < this.lanes.length; i++) {
      (function (lane) {
        var x = self.mX(lane.lane);
        var y1 = self.mY(lane.x1);
        var y2 = Math.max(self.mY(lane.x2), y1 + 12);
        var g = el('g', { 'data-lane': lane.lane });

        g.appendChild(el('rect', {
          x: x - self.colW / 2, y: 0, width: self.colW, height: self.contentHeight,
          fill: lane.lane % 2 === 0 ? 'rgba(127,127,127,0.045)' : 'transparent'
        }));

        g.appendChild(el('line', {
          x1: x, y1: y1, x2: x, y2: y2,
          stroke: lane.color, 'stroke-width': 12, 'stroke-linecap': 'round', opacity: 0.13
        }));
        g.appendChild(el('line', {
          x1: x, y1: y1, x2: x, y2: y2,
          stroke: lane.color, 'stroke-width': 3, 'stroke-linecap': 'round', opacity: 0.95
        }));

        if (lane.role === 'carrier') {
          // this branch only inherited the change, it did not author it
          g.setAttribute('opacity', '0.55');
          g.appendChild(el('line', {
            x1: x, y1: y1, x2: x, y2: y2,
            stroke: lane.color, 'stroke-width': 3, 'stroke-linecap': 'round',
            'stroke-dasharray': '7 6', opacity: 0.9
          }));
        }

        if (lane.merged) {
          g.appendChild(el('circle', {
            cx: x, cy: y2, r: 5.5, fill: 'none', stroke: lane.color, 'stroke-width': 2, opacity: 0.75
          }));
        } else {
          g.appendChild(el('circle', {
            cx: x, cy: y2, r: 5, fill: lane.color, stroke: self.theme.plotBg, 'stroke-width': 1.6
          }));
        }

        if (showTags) g.appendChild(self._branchTag(lane, x, y1 - 17));

        var title = el('title');
        title.textContent = self._laneTooltip(lane);
        g.appendChild(title);
        g.addEventListener('click', function (ev) {
          ev.stopPropagation();
          self.onLaneClick(lane);
        });
        self.laneLayer.appendChild(g);
      })(this.lanes[i]);
    }
  };

  /** ClearCase style track label.  The inferred parent branch is only shown in
   *  the tooltip (it is a guess: git has no per-element branch hierarchy). */
  Renderer.prototype._branchPathOf = function (lane) {
    return lane ? '/' + lane.name : '';
  };

  /** Mermaid's signature rounded branch label sitting on the branch line. */
  Renderer.prototype._branchTag = function (lane, cx, cy, mode) {
    var g = el('g');
    var font = '600 11px ' + FONT_UI;
    var text = mode === 'version-tree' ? this._branchPathOf(lane) : lane.name;
    text = truncateToWidth(text, font, 132);
    var w = textWidth(text, font) + 14;
    var h = 19;
    g.appendChild(el('rect', {
      x: cx - w / 2, y: cy - h / 2, width: w, height: h, rx: h / 2,
      fill: lane.color, opacity: lane.role === 'carrier' ? 0.6 : 1
    }));
    var txt = el('text', {
      x: cx, y: cy + 3.9, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 600,
      fill: '#ffffff', 'font-family': FONT_UI
    });
    txt.textContent = text;
    g.appendChild(txt);
    return g;
  };

  // ------------------------------------------------------------------
  // ClearCase style version tree (single file history, vertical tracks)
  // ------------------------------------------------------------------
  Renderer.prototype._renderVersionTree = function () {
    this.theme = readTheme();
    var s = this.size();
    this.svg.setAttribute('viewBox', '0 0 ' + s.w + ' ' + s.h);
    this.svg.innerHTML = '';
    this._buildDefs(0, s.w);

    var plot = el('g', { 'clip-path': 'url(#plotClip)' });
    this.root = el('g');
    this.grid = el('g');
    this.laneLayer = el('g');
    this.edgeLayer = el('g');
    this.mLabelLayer = el('g');
    this.nodeLayer = el('g');
    this.root.appendChild(this.grid);
    this.root.appendChild(this.laneLayer);
    this.root.appendChild(this.edgeLayer);
    this.root.appendChild(this.mLabelLayer);
    this.root.appendChild(this.nodeLayer);
    plot.appendChild(this.root);
    this.svg.appendChild(plot);

    this.labelLayer = el('g');
    this.svg.appendChild(this.labelLayer);
    this.axisLayer = el('g');
    this.svg.appendChild(this.axisLayer);

    this._drawGridVT();
    this._drawLanesVT();
    this._drawEdgesVT();
    this._drawNodesVT();
    this._applyTransform();
  };

  /** Dotted guide at every version row, so tracks can be read across. */
  Renderer.prototype._drawGridVT = function () {
    if (!this.grid) return;
    this.grid.innerHTML = '';
    var seen = {};
    for (var i = 0; i < this.nodes.length; i++) {
      var y = Math.round(this.mY(this.nodes[i].x));
      if (seen[y]) continue;
      seen[y] = true;
      this.grid.appendChild(el('line', {
        x1: 0, y1: y, x2: this.contentWidth, y2: y,
        stroke: this.theme.grid, 'stroke-width': 1, 'stroke-dasharray': '2 6'
      }));
    }
  };

  /** One vertical track per branch, labelled with its ClearCase style path. */
  Renderer.prototype._drawLanesVT = function () {
    if (!this.laneLayer) return;
    var self = this;
    this.laneLayer.innerHTML = '';
    for (var i = 0; i < this.lanes.length; i++) {
      (function (lane) {
        var x = self.mX(lane.lane);
        var versions = lane.versions || [];
        var y1 = versions.length ? self.mY(versions[0].x) : self.mY(lane.x1);
        var y2 = versions.length ? self.mY(versions[versions.length - 1].x) : self.mY(lane.x2);
        var g = el('g', { 'data-lane': lane.lane });
        if (lane.role === 'carrier') g.setAttribute('opacity', '0.55');

        g.appendChild(el('line', {
          x1: x, y1: y1, x2: x, y2: Math.max(y2, y1 + 10),
          stroke: lane.color, 'stroke-width': 3, 'stroke-linecap': 'round',
          'stroke-dasharray': lane.role === 'carrier' ? '6 5' : null, opacity: 0.9
        }));
        g.appendChild(self._branchTag(lane, x, y1 - 19, 'version-tree'));

        var title = el('title');
        title.textContent = self._laneTooltip(lane);
        g.appendChild(title);
        g.addEventListener('click', function (ev) {
          ev.stopPropagation();
          self.onLaneClick(lane);
        });
        self.laneLayer.appendChild(g);
      })(this.lanes[i]);
    }
  };

  Renderer.prototype._drawEdgesVT = function () {
    if (!this.edgeLayer) return;
    var self = this;
    this.edgeLayer.innerHTML = '';
    for (var i = 0; i < this.edges.length; i++) {
      (function (e) {
        var from = self.laneById[e.fromLane];
        var to = self.laneById[e.toLane];
        if (!from || !to) return;
        var path, title = el('title');

        if (e.kind === 'fork') {
          // branch point: the child track leaves the parent track
          var fy = self.mY(e.x1);
          path = el('path', {
            d: 'M' + self.mX(from.lane) + ',' + fy + ' H' + self.mX(to.lane),
            fill: 'none', stroke: to.color, 'stroke-width': 1.6,
            'stroke-dasharray': '5 4', opacity: 0.5
          });
          title.textContent = '分叉 ' + to.name + '  ←  ' + from.name + '\n' + e.short + '  ' + (e.subject || '');
        } else {
          // merge: dotted arrow from the source version to the version it created
          var x1 = self.mX(from.lane);
          var y1 = self.mY(e.x1);
          var target = e.targetVersion;
          var x2 = self.mX(target ? target.lane : to.lane);
          var y2 = self.mY(target ? self.normOf(target.ts) : e.x2);
          var c = Math.max((y2 - y1) * 0.45, 24);
          path = el('path', {
            d: 'M' + x1 + ',' + y1 +
               ' C' + x1 + ',' + (y1 + c) + ' ' + x2 + ',' + (y2 - c) + ' ' + x2 + ',' + (y2 - 10),
            fill: 'none', stroke: from.color, 'stroke-width': 1.8,
            'stroke-dasharray': '5 4', opacity: 0.75, 'stroke-linecap': 'round'
          });
          self.edgeLayer.appendChild(el('path', {
            d: 'M' + (x2 - 5) + ',' + (y2 - 11) + ' L' + (x2 + 5) + ',' + (y2 - 11) + ' L' + x2 + ',' + (y2 - 1) + ' Z',
            fill: from.color, opacity: 0.85
          }));
          if (!target) {
            self.edgeLayer.appendChild(el('circle', {
              cx: x2, cy: y2, r: 4.5, fill: self.theme.plotBg, stroke: from.color, 'stroke-width': 1.6
            }));
          }
          title.textContent = '合并 ' + fmtDate(e.ts) +
            '\n' + to.name + '  ←  ' + from.name +
            (target ? '\n落在版本 /' + to.name + '/' + target.n : '\n（该分支没有改过这个文件，只是继承）') +
            '\n' + e.short + '  ' + (e.subject || '');
        }
        path.appendChild(title);
        self.edgeLayer.appendChild(path);
      })(this.edges[i]);
    }
  };

  Renderer.prototype._drawNodesVT = function () {
    if (!this.nodeLayer) return;
    var self = this;
    this.nodeLayer.innerHTML = '';
    this.mLabelLayer.innerHTML = '';
    var font = '10px ' + FONT_UI;
    var chipFont = '9px ' + FONT_MONO;

    for (var i = 0; i < this.nodes.length; i++) {
      (function (n) {
        var lane = self.laneById[n.lane];
        if (!lane) return;
        var x = self.mX(n.lane);
        var y = self.mY(n.x);
        var version = null;
        var versions = lane.versions || [];
        for (var k = 0; k < versions.length; k++) {
          if (versions[k].sha === n.sha) { version = versions[k]; break; }
        }
        var g = el('g', { 'class': 'node', 'data-sha': n.sha, 'data-lane': n.lane });

        g.appendChild(el('rect', {
          x: x - VT_BOX / 2, y: y - VT_BOX / 2, width: VT_BOX, height: VT_BOX, rx: 4,
          fill: lane.color, stroke: self.theme.plotBg, 'stroke-width': 1.5
        }));
        if (version) {
          var num = el('text', {
            x: x, y: y + 3.7, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 700,
            fill: '#ffffff', 'font-family': FONT_MONO
          });
          num.textContent = String(version.n);
          g.appendChild(num);
        }

        // git tags play the role of ClearCase version labels: LBL_xxx
        var labels = (version && version.labels && version.labels.length)
          ? version.labels : (n.labels || []);
        var chipX = x - VT_BOX / 2 - 6;
        for (var li = labels.length - 1; li >= 0; li--) {
          var chipText = truncateToWidth(labels[li], chipFont, 96);
          var cw = textWidth(chipText, chipFont) + 10;
          chipX -= cw;
          g.appendChild(el('rect', {
            x: chipX, y: y - 8, width: cw, height: 16, rx: 3,
            fill: 'rgba(226,163,54,0.16)', stroke: '#e2a336', 'stroke-width': 1
          }));
          var ct = el('text', {
            x: chipX + 5, y: y + 3.4, 'font-size': 9, fill: '#e2a336', 'font-family': FONT_MONO
          });
          ct.textContent = chipText;
          g.appendChild(ct);
          chipX -= 4;
        }

        var text = n.subject || n.short;
        if (n.status) text += '  · ' + n.status;
        var shown = truncateToWidth(text, font, VT_TEXT_W);
        var lt = el('text', {
          x: x + VT_BOX / 2 + 7, y: y + 3.5, 'font-size': 10,
          fill: self.theme.fg, 'font-family': FONT_UI,
          stroke: self.theme.plotBg, 'stroke-width': 2.6, 'stroke-linejoin': 'round',
          'paint-order': 'stroke'
        });
        lt.textContent = shown;
        g.appendChild(lt);

        var t = el('title');
        t.textContent = (version ? self._branchPathOf(lane) + '/' + version.n + '  ' : '') +
          n.short + '  ' + fmtDate(n.ts, true) + '\n' + lane.name + '\n' + (n.subject || '') +
          '\n' + (n.author || '') + (n.status ? '\n状态: ' + n.status : '') +
          (labels.length ? '\n标签: ' + labels.join(', ') : '');
        g.appendChild(t);

        g.addEventListener('click', function (ev) {
          ev.stopPropagation();
          self.onNodeClick(n, lane);
        });
        self.nodeLayer.appendChild(g);
      })(this.nodes[i]);
    }
  };

  Renderer.prototype._drawEdgesM = function () {
    if (!this.edgeLayer) return;
    var self = this;
    this.edgeLayer.innerHTML = '';
    for (var i = 0; i < this.edges.length; i++) {
      (function (e) {
        var from = self.laneById[e.fromLane];
        var to = self.laneById[e.toLane];
        if (!from || !to) return;
        var x1 = self.mX(from.lane);
        var x2 = self.mX(to.lane);
        var y1 = self.mY(e.x1);
        var y2 = self.mY(e.x2);
        var path;
        if (e.kind === 'fork') {
          path = el('path', {
            d: 'M' + x1 + ',' + y1 + ' H' + x2,
            fill: 'none', stroke: to.color, 'stroke-width': 1.8,
            'stroke-dasharray': '5 4', opacity: 0.55, 'stroke-linecap': 'round'
          });
        } else {
          var c = Math.max((y2 - y1) * 0.5, 26);
          path = el('path', {
            d: 'M' + x1 + ',' + y1 +
               ' C' + x1 + ',' + (y1 + c) + ' ' + x2 + ',' + (y2 - c) + ' ' + x2 + ',' + y2,
            fill: 'none', stroke: to.color, 'stroke-width': 2.2, opacity: 0.8, 'stroke-linecap': 'round'
          });
        }
        var t = el('title');
        var edgeTs = Math.round(e.x2 * (self.range.maxTs - self.range.minTs) + self.range.minTs);
        t.textContent = (e.kind === 'merge' ? '合并 ' : '分叉 ') + fmtDate(edgeTs, true) +
          '\n' + (to.name || '') + '  ←  ' + (from.name || '') + '\n' + e.short + '  ' + (e.subject || '');
        path.appendChild(t);
        self.edgeLayer.appendChild(path);

        if (e.kind === 'merge') {
          // arrow head landing on the receiving branch line
          self.edgeLayer.appendChild(el('path', {
            d: 'M' + (x2 - 5) + ',' + (y2 - 11) + ' L' + (x2 + 5) + ',' + (y2 - 11) + ' L' + x2 + ',' + (y2 - 1) + ' Z',
            fill: to.color, opacity: 0.85
          }));
        }
      })(this.edges[i]);
    }
  };

  Renderer.prototype._wantText = function () {
    var rowH = this.rowH || LANE_H;
    return !!this.showSubjects && this.k >= M_FONT_MIN && this.k * rowH >= M_ROW_H_MIN;
  };

  Renderer.prototype._drawNodesM = function () {
    if (!this.nodeLayer) return;
    var self = this;
    this.nodeLayer.innerHTML = '';
    this.mLabelLayer.innerHTML = '';
    var showText = this._wantText();
    this._textOn = showText;
    var font = '10.5px ' + FONT_UI;
    var maxLabelW = Math.min(2.6 * this.colW, 240 / this.k);
    // the same merge commit sits on several lanes -- label it only once
    var labelled = {};

    for (var i = 0; i < this.nodes.length; i++) {
      (function (n) {
        var lane = self.laneById[n.lane];
        if (!lane) return;
        var x = self.mX(n.lane);
        var y = self.mY(n.x);
        var row = Math.round(y);
        var g = el('g', { 'class': 'node', 'data-sha': n.sha, 'data-lane': n.lane });

        if (n.kind === 'merge') {
          g.appendChild(el('circle', { cx: x, cy: y, r: 5.5, fill: lane.color, stroke: self.theme.plotBg, 'stroke-width': 1.4 }));
          g.appendChild(el('circle', { cx: x, cy: y, r: 9.5, fill: 'none', stroke: lane.color, 'stroke-width': 1.4, opacity: 0.55 }));
        } else if (n.kind === 'fork') {
          g.appendChild(el('circle', { cx: x, cy: y, r: 5.5, fill: self.theme.plotBg, stroke: lane.color, 'stroke-width': 2 }));
        } else if (n.kind === 'tip') {
          g.appendChild(el('circle', { cx: x, cy: y, r: 6, fill: lane.color, stroke: self.theme.plotBg, 'stroke-width': 1.5 }));
          g.appendChild(el('circle', { cx: x, cy: y, r: 10, fill: 'none', stroke: lane.color, 'stroke-width': 1, opacity: 0.4 }));
        } else {
          g.appendChild(el('circle', { cx: x, cy: y, r: 4.5, fill: lane.color, stroke: self.theme.plotBg, 'stroke-width': 1.4 }));
        }

        var t = el('title');
        t.textContent = n.short + '  ' + fmtDate(n.ts, true) + '\n' + lane.name + '\n' + (n.subject || '') +
          '\n' + (n.author || '') + (n.status ? '\n状态: ' + n.status : '');
        g.appendChild(t);

        g.addEventListener('click', function (ev) {
          ev.stopPropagation();
          self.onNodeClick(n, lane);
        });
        self.nodeLayer.appendChild(g);

        var text = n.subject || n.short;
        if (!showText || !text) return;
        var key = n.sha + '@' + row;
        if (labelled[key]) return;
        labelled[key] = true;
        var label = truncateToWidth(text, font, maxLabelW);
        var w = textWidth(label, font) + 13;
        var lx = x + 12;
        // neighbouring columns are close: stagger the boxes so they do not collide
        var ly = y - 9 + (n.lane % 2 ? 1 : -1) * self.rowH * 0.45;
        self.mLabelLayer.appendChild(el('rect', {
          x: lx, y: ly, width: w, height: 18, rx: 5,
          fill: self.theme.plotBg, opacity: 0.9,
          stroke: lane.color, 'stroke-width': 1, 'stroke-opacity': 0.45
        }));
        var lt = el('text', {
          x: lx + 6.5, y: ly + 12.5, 'font-size': 10.5,
          fill: self.theme.fg, 'font-family': FONT_UI
        });
        lt.textContent = label;
        self.mLabelLayer.appendChild(lt);
      })(this.nodes[i]);
    }
  };

  /** Screen-space branch header (pans with the columns, stays at the top). */
  Renderer.prototype._drawMermaidLabels = function () {
    if (!this.labelLayer) return;
    var self = this;
    var s = this.size();
    this.labelLayer.innerHTML = '';
    this.labelLayer.appendChild(el('rect', {
      x: 0, y: 0, width: s.w, height: M_HEADER_H, fill: this.theme.plotBg, opacity: 0.95
    }));

    if (this.showLabels) {
      var colW = this.k * this.colW;
      var fontSize = clamp(11.5 * Math.sqrt(this.k), 8.5, 12);
      var nameFont = fontSize + 'px ' + FONT_MONO;
      for (var i = 0; i < this.lanes.length; i++) {
        (function (lane) {
          var cx = self.tx + self.k * self.mX(lane.lane);
          if (cx < -colW / 2 || cx > s.w + colW / 2) return;
          var g = el('g', { 'data-lane': lane.lane });
          if (lane.role === 'carrier') g.setAttribute('opacity', '0.65');

          g.appendChild(el('rect', {
            x: cx - 9, y: 6, width: 18, height: 3.5, rx: 1.75, fill: lane.color,
            opacity: lane.kind === 'fixed' ? 1 : 0.85
          }));

          var txt = el('text', {
            x: cx, y: 26, 'text-anchor': 'middle', 'font-size': fontSize,
            fill: self.theme.fg, 'font-family': FONT_MONO,
            'font-weight': lane.kind === 'fixed' ? 700 : 400
          });
          var visual = self._vstyle() === 'version-tree' ? self._branchPathOf(lane) : lane.name;
          txt.textContent = truncateToWidth(visual, nameFont, Math.max(34, colW - 6));
          g.appendChild(txt);

          var sub = el('text', {
            x: cx, y: 38, 'text-anchor': 'middle', 'font-size': 9.5,
            fill: self.theme.fgMuted, 'font-family': FONT_UI
          });
          sub.textContent = truncateToWidth(self._laneSub(lane), '9.5px ' + FONT_UI, Math.max(36, colW - 4));
          g.appendChild(sub);

          var t = el('title');
          t.textContent = self._laneTooltip(lane);
          g.appendChild(t);
          g.addEventListener('click', function (ev) {
            ev.stopPropagation();
            self.onLaneClick(lane);
          });
          self.labelLayer.appendChild(g);
        })(this.lanes[i]);
      }
    }

    this.labelLayer.appendChild(el('line', {
      x1: 0, y1: M_HEADER_H, x2: s.w, y2: M_HEADER_H, stroke: this.theme.border, 'stroke-width': 1
    }));
  };

  Renderer.prototype._laneSub = function (lane) {
    if (this._vstyle() === 'version-tree') {
      if (lane.role === 'carrier') return '继承改动';
      return (lane.versions || []).length + ' 个版本';
    }
    if (this.mode === 'file') {
      return lane.role === 'author' ? '提交了 ' + lane.ownCount + ' 次改动' : '承载改动';
    }
    var bits = [];
    if (lane.kind !== 'fixed') bits.push(lane.ownCount + ' 提交');
    if (lane.mergedInto && lane.mergedInto.length) bits.push('→ ' + lane.mergedInto[lane.mergedInto.length - 1].intoBranch);
    else if (lane.kind !== 'fixed') bits.push('未合并');
    return bits.join(' · ') || '固定分支';
  };

  /** Right-hand vertical date axis. */
  Renderer.prototype._drawMermaidAxis = function () {
    if (!this.axisLayer) return;
    var s = this.size();
    this.axisLayer.innerHTML = '';
    if (!this.payload || !this.range.maxTs) return;
    var theme = this.theme;
    var span = Math.max(1, this.range.maxTs - this.range.minTs);

    var cap = el('text', {
      x: 12, y: s.h - 10, 'font-size': 10,
      fill: theme.fgMuted, 'font-family': FONT_MONO
    });
    cap.textContent = fmtDate(this.range.minTs) + ' → ' + fmtDate(this.range.maxTs) +
      '  (' + fmtSpan(span) + '，' + this.lanes.length + ' 个分支，' + this.rowCount + ' 个时间点)';
    this.axisLayer.appendChild(cap);
    if (!this.showAxis) return;

    // the date axis hugs the right edge of the branch columns
    var right = this.tx + this.k * ((this.padLeft === undefined ? M_PAD_LEFT : this.padLeft) + this.laneCount * this.colW);
    var ax = clamp(right + 26, 140, Math.max(140, s.w - 84));
    this.axisLayer.appendChild(el('line', {
      x1: ax, y1: M_HEADER_H, x2: ax, y2: s.h - 22, stroke: theme.border, 'stroke-width': 1
    }));

    var ticks = this._ticks();
    var lastY = -1e9;
    for (var i = 0; i < ticks.length; i++) {
      var y = this.ty + this.k * this.mY((ticks[i] - this.range.minTs) / span);
      if (y < M_HEADER_H + 12 || y > s.h - 26) continue;
      if (y - lastY < 22) continue;
      lastY = y;
      this.axisLayer.appendChild(el('line', { x1: ax, y1: y, x2: ax + 4, y2: y, stroke: theme.border }));
      var txt = el('text', { x: ax + 8, y: y + 3.5, 'font-size': 10, fill: theme.fgMuted, 'font-family': FONT_MONO });
      txt.textContent = fmtDateShort(ticks[i]);
      this.axisLayer.appendChild(txt);
    }
  };

  // ------------------------------------------------------------------
  // mermaid LR style: dotted row guides / branch rows / elbows / commits
  // ------------------------------------------------------------------
  /** Faint dotted guide along every branch row, like mermaid's lanes. */
  Renderer.prototype._drawGuidesLR = function () {
    if (!this.guideLayer) return;
    this.guideLayer.innerHTML = '';
    for (var i = 0; i < this.lanes.length; i++) {
      var y = this.laneY(this.lanes[i].lane);
      this.guideLayer.appendChild(el('line', {
        x1: 0, y1: y, x2: this.totalWidth, y2: y,
        stroke: this.theme.grid, 'stroke-width': 1, 'stroke-dasharray': '2 5'
      }));
    }
  };

  /** A branch row runs to its head, or further when merges feed other branches. */
  Renderer.prototype._laneRowEnd = function (lane) {
    var end = lane.x2 || 0;
    for (var i = 0; i < this.edges.length; i++) {
      var e = this.edges[i];
      if (e.kind === 'merge' && e.fromLane === lane.lane && e.x2 > end) end = e.x2;
    }
    return end;
  };

  Renderer.prototype._drawLanesLR = function () {
    if (!this.laneLayer) return;
    var self = this;
    this.laneLayer.innerHTML = '';
    for (var i = 0; i < this.lanes.length; i++) {
      (function (lane) {
        var y = self.laneY(lane.lane);
        var x1 = self.xPx(lane.x1);
        var x2 = Math.max(self.xPx(self._laneRowEnd(lane)), x1 + 10);
        var g = el('g', { 'data-lane': lane.lane });

        g.appendChild(el('line', {
          x1: x1, y1: y, x2: x2, y2: y,
          stroke: lane.color, 'stroke-width': 10, 'stroke-linecap': 'round', opacity: 0.15
        }));
        g.appendChild(el('line', {
          x1: x1, y1: y, x2: x2, y2: y,
          stroke: lane.color, 'stroke-width': 3, 'stroke-linecap': 'round', opacity: 0.95
        }));

        if (lane.role === 'carrier') {
          // this branch only inherited the change, it did not author it
          g.setAttribute('opacity', '0.55');
          g.appendChild(el('line', {
            x1: x1, y1: y, x2: x2, y2: y,
            stroke: lane.color, 'stroke-width': 3, 'stroke-linecap': 'round',
            'stroke-dasharray': '7 6', opacity: 0.9
          }));
        }

        if (!lane.merged && !(lane.mergedInto && lane.mergedInto.length)) {
          // head of a branch that never merged: solid end dot
          g.appendChild(el('circle', {
            cx: x2, cy: y, r: 5, fill: lane.color, stroke: self.theme.plotBg, 'stroke-width': 1.6
          }));
        }

        var title = el('title');
        title.textContent = self._laneTooltip(lane);
        g.appendChild(title);
        g.addEventListener('click', function (ev) {
          ev.stopPropagation();
          self.onLaneClick(lane);
        });
        self.laneLayer.appendChild(g);
      })(this.lanes[i]);
    }
  };

  /** Fork drops and merge rises: the vertical parts of a branch's "staple". */
  Renderer.prototype._drawEdgesLR = function () {
    if (!this.edgeLayer) return;
    var self = this;
    this.edgeLayer.innerHTML = '';

    function elbow(x, fromY, toY, color, arrow) {
      var dir = toY > fromY ? 1 : -1;
      var r = Math.min(LR_CORNER, Math.abs(toY - fromY) / 2);
      var d;
      if (arrow === 'start') {
        // leave the branch row at the bottom, then rise/fall to the target row
        d = 'M' + (x - r) + ',' + fromY +
            ' Q' + x + ',' + fromY + ' ' + x + ',' + (fromY + dir * r) +
            ' L' + x + ',' + toY;
      } else {
        d = 'M' + x + ',' + fromY +
            ' L' + x + ',' + (toY - dir * r) +
            ' Q' + x + ',' + toY + ' ' + (x + r) + ',' + toY;
      }
      var path = el('path', {
        d: d, fill: 'none', stroke: color, 'stroke-width': 3,
        'stroke-linecap': 'round', opacity: 0.95
      });
      return path;
    }

    for (var i = 0; i < this.edges.length; i++) {
      (function (e) {
        var from = self.laneById[e.fromLane];
        var to = self.laneById[e.toLane];
        if (!from || !to) return;
        var fromY = self.laneY(from.lane);
        var toY = self.laneY(to.lane);
        if (fromY === toY) return;
        var x = self.xPx(e.kind === 'fork' ? e.x1 : e.x2);
        var color = e.kind === 'fork' ? to.color : from.color;
        var path = e.kind === 'fork'
          ? elbow(x, fromY, toY, color, 'end')
          : elbow(x, fromY, toY, color, 'start');
        var t = el('title');
        var edgeTs = Math.round(e.x2 * (self.range.maxTs - self.range.minTs) + self.range.minTs);
        t.textContent = (e.kind === 'merge' ? '合并 ' : '分叉 ') + fmtDate(edgeTs, true) +
          '\n' + (to.name || '') + '  ←  ' + (from.name || '') + '\n' + e.short + '  ' + (e.subject || '');
        path.appendChild(t);
        self.edgeLayer.appendChild(path);
      })(this.edges[i]);
    }

    // fixed branches get no fork edge from the backend: draw their drop here
    for (var j = 0; j < this.lanes.length; j++) {
      (function (lane) {
        if (lane.kind !== 'fixed' || !lane.parentName || lane.forkX === null || lane.forkX === undefined) return;
        var parent = null;
        for (var m = 0; m < self.lanes.length; m++) {
          if (self.lanes[m].name === lane.parentName) parent = self.lanes[m];
        }
        if (!parent || parent.lane === lane.lane) return;
        var fromY = self.laneY(parent.lane);
        var toY = self.laneY(lane.lane);
        if (fromY === toY) return;
        var path = elbow(self.xPx(lane.x1), fromY, toY, lane.color, 'end');
        var t = el('title');
        t.textContent = '分叉 ' + lane.name + '  ←  ' + parent.name;
        path.appendChild(t);
        self.edgeLayer.appendChild(path);
      })(this.lanes[j]);
    }
  };

  Renderer.prototype._drawNodesLR = function () {
    if (!this.nodeLayer) return;
    var self = this;
    this.nodeLayer.innerHTML = '';
    this.mLabelLayer.innerHTML = '';
    var showText = this._wantText();
    this._textOn = showText;
    var font = '9.5px ' + FONT_UI;
    var maxLabelW = LR_LABEL_H;
    // the same merge commit sits on several rows -- label it only once
    var labelled = {};

    for (var i = 0; i < this.nodes.length; i++) {
      (function (n) {
        var lane = self.laneById[n.lane];
        if (!lane) return;
        var x = self.xPx(n.x);
        var y = self.laneY(n.lane);
        var g = el('g', { 'class': 'node', 'data-sha': n.sha, 'data-lane': n.lane });

        if (n.kind === 'merge') {
          // mermaid draws merge commits as a filled double circle
          g.appendChild(el('circle', {
            cx: x, cy: y, r: 7, fill: lane.color, 'fill-opacity': 0.22
          }));
          g.appendChild(el('circle', {
            cx: x, cy: y, r: 5.2, fill: self.theme.plotBg, stroke: lane.color, 'stroke-width': 2.4
          }));
        } else if (n.kind === 'fork') {
          g.appendChild(el('circle', {
            cx: x, cy: y, r: 4.6, fill: self.theme.plotBg, stroke: lane.color, 'stroke-width': 2
          }));
        } else if (n.kind === 'tip') {
          g.appendChild(el('circle', { cx: x, cy: y, r: 6, fill: lane.color, stroke: self.theme.plotBg, 'stroke-width': 1.5 }));
          g.appendChild(el('circle', { cx: x, cy: y, r: 10, fill: 'none', stroke: lane.color, 'stroke-width': 1, opacity: 0.4 }));
        } else {
          g.appendChild(el('circle', { cx: x, cy: y, r: 4.5, fill: lane.color, stroke: self.theme.plotBg, 'stroke-width': 1.4 }));
        }

        var t = el('title');
        t.textContent = n.short + '  ' + fmtDate(n.ts, true) + '\n' + lane.name + '\n' + (n.subject || '') +
          '\n' + (n.author || '') + (n.status ? '\n状态: ' + n.status : '');
        g.appendChild(t);

        g.addEventListener('click', function (ev) {
          ev.stopPropagation();
          self.onNodeClick(n, lane);
        });
        self.nodeLayer.appendChild(g);

        var text = n.subject || n.short;
        if (!showText || !text) return;
        var key = n.sha + '@' + n.lane;
        if (labelled[key]) return;
        labelled[key] = true;
        var label = truncateToWidth(text, font, maxLabelW);
        var ly = y + 11;   // labels hang under the row, rotated 90 degrees
        var lt = el('text', {
          x: x + 4.5, y: ly, 'font-size': 9.5, fill: self.theme.fgMuted, 'font-family': FONT_UI,
          'text-anchor': 'end', transform: 'rotate(-90 ' + (x + 4.5) + ' ' + ly + ')',
          // a halo in the plot colour keeps the text readable over the row below
          stroke: self.theme.plotBg, 'stroke-width': 3, 'stroke-linejoin': 'round',
          'paint-order': 'stroke'
        });
        lt.textContent = label;
        self.mLabelLayer.appendChild(lt);
      })(this.nodes[i]);
    }
  };

  /** Gutter pills with the branch name, mermaid style. */
  Renderer.prototype._drawLabelsLR = function () {
    if (!this.labelLayer) return;
    var self = this;
    var s = this.size();
    this.labelLayer.innerHTML = '';
    var fontSize = clamp(11.5 * Math.sqrt(this.k), 9, 12.5);
    var font = '600 ' + fontSize + 'px ' + FONT_UI;
    var maxW = Math.max(56, GUTTER - 44);

    for (var i = 0; i < this.lanes.length; i++) {
      (function (lane) {
        var y = self.ty + self.k * self.laneY(lane.lane);
        if (y < 12 || y > s.h - 8) return;
        var name = self.showLabels ? truncateToWidth(lane.name, font, maxW) : '';
        var w = name ? textWidth(name, font) + 17 : 20;
        var g = el('g', { 'data-lane': lane.lane });
        if (lane.role === 'carrier') g.setAttribute('opacity', '0.65');

        g.appendChild(el('rect', {
          x: 8, y: y - 9, width: w, height: 18, rx: 9,
          fill: lane.color, opacity: lane.kind === 'fixed' ? 0.95 : 0.85
        }));
        if (name) {
          var txt = el('text', {
            x: 8 + w / 2, y: y + 4, 'text-anchor': 'middle',
            'font-size': fontSize, 'font-weight': 600, fill: '#ffffff', 'font-family': FONT_UI
          });
          txt.textContent = name;
          g.appendChild(txt);
        }

        var t = el('title');
        t.textContent = self._laneTooltip(lane);
        g.appendChild(t);
        g.addEventListener('click', function (ev) {
          ev.stopPropagation();
          self.onLaneClick(lane);
        });
        self.labelLayer.appendChild(g);
      })(this.lanes[i]);
    }

    this.labelLayer.appendChild(el('line', {
      x1: GUTTER - 8, y1: 0, x2: GUTTER - 8, y2: s.h,
      stroke: this.theme.border, 'stroke-width': 1
    }));
  };

  Renderer.prototype._drawLabels = function () {
    if (!this.labelLayer) return;
    var vstyle = this._vstyle();
    if (vstyle === 'mermaid' || vstyle === 'version-tree') return this._drawMermaidLabels();
    if (vstyle === 'mermaid-lr') return this._drawLabelsLR();
    this.labelLayer.innerHTML = '';
    if (!this.showLabels) return;
    var self = this;
    var spacing = LANE_H * this.k;
    var showSub = spacing > 26;
    var fontSize = clamp(11.5 * Math.sqrt(this.k), 8.5, 13);

    if (this.payload && this.payload.stats) {
      var header = el('text', { x: 12, y: 18, 'font-size': 11, fill: self.theme.fgMuted, 'font-family': FONT_UI });
      header.textContent = this.mode === 'file'
        ? '分支 / 泳道  ·  ' + (this.payload.path || '')
        : '分支 / 泳道';
      this.labelLayer.appendChild(header);
    }

    for (var i = 0; i < this.lanes.length; i++) {
      (function (lane) {
        var y = self.ty + self.k * self.laneY(lane.lane);
        if (y < 24 || y > self.size().h - 4) return;
        var g = el('g', { 'data-lane': lane.lane });

        g.appendChild(el('rect', {
          x: 8, y: y - 5.5, width: 10, height: 11, rx: 2.5, fill: lane.color,
          opacity: lane.kind === 'fixed' ? 1 : 0.85
        }));

        var name = lane.name.length > 22 ? lane.name.slice(0, 21) + '…' : lane.name;
        var txt = el('text', {
          x: 24, y: y + 4, 'font-size': fontSize, fill: self.theme.fg,
          'font-family': FONT_MONO,
          'font-weight': lane.kind === 'fixed' ? 700 : 400
        });
        txt.textContent = name;
        g.appendChild(txt);

        if (showSub) {
          var sub = el('text', { x: 24, y: y + 15, 'font-size': 9.5, fill: self.theme.fgMuted, 'font-family': FONT_UI });
          var bits = [];
          if (self.mode === 'file') {
            if (lane.role === 'author') bits.push('提交了 ' + lane.ownCount + ' 次改动');
            else bits.push('承载改动');
          } else {
            if (lane.kind !== 'fixed') bits.push(lane.ownCount + ' 提交');
            if (lane.mergedInto && lane.mergedInto.length) bits.push('→ ' + lane.mergedInto[lane.mergedInto.length - 1].intoBranch);
            else if (lane.kind !== 'fixed') bits.push('未合并');
          }
          sub.textContent = bits.join(' · ');
          g.appendChild(sub);
        }

        var t = el('title');
        t.textContent = self._laneTooltip(lane);
        g.appendChild(t);
        g.addEventListener('click', function (ev) {
          ev.stopPropagation();
          self.onLaneClick(lane);
        });
        self.labelLayer.appendChild(g);
      })(this.lanes[i]);
    }

    // separator line between gutter and plot
    this.labelLayer.appendChild(el('line', {
      x1: GUTTER - 8, y1: 0, x2: GUTTER - 8, y2: this.size().h,
      stroke: this.theme.border, 'stroke-width': 1
    }));
  };

  Renderer.prototype._drawAxis = function () {
    if (!this.axisLayer) return;
    var vstyle = this._vstyle();
    if (vstyle === 'mermaid' || vstyle === 'version-tree') return this._drawMermaidAxis();
    this.axisLayer.innerHTML = '';
    if (!this.showAxis || !this.payload || !this.range.maxTs) return;
    var h = this.size().h;
    var y = h - 26;
    var span = Math.max(1, this.range.maxTs - this.range.minTs);
    var spanText = span >= 2 * DAY
      ? (span / DAY).toFixed(0) + ' 天'
      : (span / 3600).toFixed(1) + ' 小时';
    var ticks = this._ticks();

    var theme = this.theme;
    this.axisLayer.appendChild(el('line', {
      x1: GUTTER, y1: y, x2: this.size().w, y2: y, stroke: theme.border, 'stroke-width': 1
    }));

    for (var i = 0; i < ticks.length; i++) {
      var x = this.tx + this.k * this.xPx((ticks[i] - this.range.minTs) / span);
      if (x < GUTTER - 4 || x > this.size().w) continue;
      this.axisLayer.appendChild(el('line', { x1: x, y1: y - 4, x2: x, y2: y + 4, stroke: theme.border }));
      var txt = el('text', { x: x + 3, y: y + 15, 'font-size': 10, fill: theme.fgMuted, 'font-family': FONT_MONO });
      txt.textContent = fmtDateShort(ticks[i]);
      this.axisLayer.appendChild(txt);
    }

    var range = el('text', { x: GUTTER, y: y - 12, 'font-size': 10, fill: theme.fgMuted, 'font-family': FONT_MONO });
    range.textContent = fmtDate(this.range.minTs) + '  →  ' + fmtDate(this.range.maxTs) +
      '   (' + spanText + '，' + this.lanes.length + (this.style === 'lanes' ? ' 条泳道)' : ' 个分支)');
    this.axisLayer.appendChild(range);
  };

  Renderer.prototype.resize = function () {
    if (!this.payload) return;
    var s = this.size();
    var vstyle = this._vstyle();
    var full = vstyle === 'mermaid' || vstyle === 'version-tree';
    this.svg.setAttribute('viewBox', '0 0 ' + s.w + ' ' + s.h);
    if (this._clipRect) {
      this._clipRect.setAttribute('width', Math.max(0, full ? s.w : s.w - GUTTER));
      this._clipRect.setAttribute('height', s.h);
    }
    this._drawLabels();
    this._drawAxis();
  };

  // ------------------------------------------------------------------
  // export
  // ------------------------------------------------------------------
  Renderer.prototype.serialize = function () {
    var clone = this.svg.cloneNode(true);
    var s = this.size();
    var bboxW = this.totalWidth + GUTTER;
    var bboxH = this.contentHeight;
    clone.setAttribute('viewBox', (-this.tx / this.k) + ' ' + (-this.ty / this.k) + ' ' + (s.w / this.k) + ' ' + (s.h / this.k));
    clone.setAttribute('width', s.w);
    clone.setAttribute('height', s.h);
    clone.setAttribute('xmlns', NS);
    clone.removeAttribute('class');
    var style = document.createElementNS(NS, 'style');
    style.textContent = 'text{font-family:' + FONT_MONO + '}';
    clone.insertBefore(style, clone.firstChild);
    return { xml: new XMLSerializer().serializeToString(clone), w: s.w, h: s.h, bboxW: bboxW, bboxH: bboxH };
  };

  Renderer.prototype.exportSvg = function (filename) {
    var data = this.serialize();
    var blob = new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + data.xml], { type: 'image/svg+xml;charset=utf-8' });
    download(blob, filename);
  };

  Renderer.prototype.exportPng = function (filename) {
    var data = this.serialize();
    var scale = 2;
    var blob = new Blob([data.xml], { type: 'image/svg+xml;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var img = new Image();
    img.onload = function () {
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(data.w * scale);
      canvas.height = Math.round(data.h * scale);
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--plot-bg').trim() || '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(function (out) { if (out) download(out, filename); }, 'image/png');
    };
    img.onerror = function () { URL.revokeObjectURL(url); };
    img.src = url;
  };

  function download(blob, filename) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 500);
  }

  global.GitTreeGraph = {
    Renderer: Renderer,
    GUTTER: GUTTER,
    LANE_H: LANE_H,
    fmtDate: fmtDate,
    fmtDateShort: fmtDateShort
  };
})(window);
