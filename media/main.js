/*
 * 版本树面板的胶水层。
 *
 * graph.js 负责画（整份拷贝，自己维护）；这里只做三件事：
 *   1. 初始化 Renderer，并把它锁在版本树模式（fileStyle: 'tree'）
 *   2. 收扩展发来的 payload 塞进渲染器
 *   3. 把点击等交互回抛给扩展（扩展那边才能碰 git）
 *
 * 刻意不走 HTTP：版本树数据由扩展的 TS 直接算，见 src/filegraph.ts。
 */
(function () {
  'use strict';

  var vscode = acquireVsCodeApi();

  var svg = document.getElementById('svg');
  var warningsEl = document.getElementById('warnings');
  var statsEl = document.getElementById('stats');
  var pathEl = document.getElementById('filePath');
  var followEl = document.getElementById('optFollow');
  var scopeEl = document.getElementById('scopeSeg');
  var renderer = null;

  function initRenderer() {
    renderer = new window.GitTreeGraph.Renderer(svg, {
      // 版本树下 style 用不上——_vstyle() 会因为 fileStyle==='tree' 走 'version-tree'
      style: 'lanes',
      fileStyle: 'tree',
      onNodeClick: function (node, lane, ev) {
        // 合并节点：默认看本分支上合并前后的对比；Alt+点看来源那个版本
        var alt = !!(ev && (ev.altKey || ev.metaKey || ev.ctrlKey));
        var altSha = node.via ? node.via.sha : '';
        vscode.postMessage({ type: 'openDiff', sha: node.sha, alt: alt, altSha: altSha });
      },
      onCopy: function (text) {
        // webview 里的 navigator.clipboard 不保证可用，统一交给扩展写剪贴板
        vscode.postMessage({ type: 'copy', text: text });
      },
      onLaneClick: function (lane) {
        vscode.postMessage({
          type: 'toast',
          text: lane.name + '：' + lane.ownCount + ' 个版本，' +
            (lane.mergeCount ? lane.mergeCount + ' 次合并，' : '') +
            (lane.role === 'carrier' ? '仅承载改动' : '改动来源')
        });
      }
    });
    window.addEventListener('resize', function () {
      if (renderer) renderer.resize();
    });
  }

  function markScope(scope) {
    var buttons = scopeEl.getElementsByTagName('button');
    for (var i = 0; i < buttons.length; i++) {
      var on = buttons[i].getAttribute('data-scope') === scope;
      buttons[i].className = on ? 'active' : '';
    }
  }

  function renderWarnings(list) {
    if (!list || !list.length) {
      warningsEl.className = 'warnings hidden';
      warningsEl.textContent = '';
      return;
    }
    warningsEl.className = 'warnings';
    warningsEl.textContent = list.map(function (w) { return '⚠ ' + w; }).join('\n');
  }

  function renderStats(payload) {
    var s = payload.stats || {};
    var parts = [
      payload.lanes.length + ' 条轨道',
      (s.merges || 0) + ' 次合并'
    ];
    if (s.tags) parts.push(s.tags + ' 个标签');
    if (s.branches) parts.push(s.branches + ' 个分支');
    statsEl.textContent = parts.join(' · ');
  }

  window.addEventListener('message', function (event) {
    var msg = event.data || {};
    if (msg.type === 'payload') {
      pathEl.textContent = msg.payload.path;
      pathEl.title = msg.payload.path;
      followEl.checked = !!msg.payload.follow;
      markScope(msg.payload.scope || 'local');
      renderWarnings(msg.payload.warnings);
      renderStats(msg.payload);
      renderer.setData(msg.payload, 'file');
      // 面板刚建出来时 svg 可能还没拿到尺寸，下一帧再 resize 一次
      requestAnimationFrame(function () { renderer.resize(); });
    } else if (msg.type === 'error') {
      renderWarnings([msg.message]);
    } else if (msg.type === 'busy') {
      document.body.classList.toggle('busy', !!msg.value);
    }
  });

  document.getElementById('refreshBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'refresh' });
  });

  followEl.addEventListener('change', function () {
    vscode.postMessage({ type: 'setFollow', value: !!followEl.checked });
  });

  scopeEl.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.getAttribute) return;
    var scope = target.getAttribute('data-scope');
    if (!scope) return;
    markScope(scope);
    vscode.postMessage({ type: 'setScope', value: scope });
  });

  document.getElementById('exportBtn').addEventListener('click', function () {
    if (!renderer || !renderer.payload) return;
    // webview 里 blob: + <a download> 不可靠，交给扩展用 workspace.fs 落盘
    var data = renderer.serialize();
    vscode.postMessage({ type: 'saveSvg', xml: data.xml });
  });

  initRenderer();
  vscode.postMessage({ type: 'ready' });
})();
