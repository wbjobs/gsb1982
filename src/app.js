/* 主应用：SVG 渲染 + 交互（网格吸附 / 对齐线 / 正交连线）+ Worker 路由调度 + 导出 */
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var PORT_SIDES = ['top', 'right', 'bottom', 'left'];

  var els = {
    scene: document.getElementById('scene'),
    wrap: document.getElementById('canvasWrap'),
    edgeLayer: document.getElementById('edgeLayer'),
    guideLayer: document.getElementById('guideLayer'),
    tempLayer: document.getElementById('tempLayer'),
    nodeLayer: document.getElementById('nodeLayer'),
    gridRect: document.getElementById('gridRect'),
    gridPattern: document.querySelector('#gridPattern'),
    toastHost: document.getElementById('toastHost'),
    snapToggle: document.getElementById('snapToggle'),
    guideToggle: document.getElementById('guideToggle'),
    gridToggle: document.getElementById('gridToggle'),
    gridSize: document.getElementById('gridSize'),
    channel: document.getElementById('channel'),
    statNodes: document.getElementById('statNodes'),
    statEdges: document.getElementById('statEdges'),
    statOverlap: document.getElementById('statOverlap'),
    statRouteTime: document.getElementById('statRouteTime'),
    statFps: document.getElementById('statFps')
  };

  var state = {
    nodes: [],
    edges: [],
    paths: {},
    selectedNode: null,
    selectedEdge: null
  };

  var refs = {
    nodes: new Map(),
    edges: new Map()
  };

  var settings = {
    snap: true,
    guides: true,
    grid: 20,
    channel: 20
  };

  var router = new RouterClient(4000);
  var routeToken = 0;
  var routeTimer = null;
  var nodeSeq = 0;
  var edgeSeq = 0;
  var lastToastAt = new Map();

  /* ---------------- toast / 状态栏 ---------------- */

  function toast(message, level) {
    var now = Date.now();
    var last = lastToastAt.get(message) || 0;
    if (now - last < 1500) return;
    lastToastAt.set(message, now);

    var div = document.createElement('div');
    div.className = 'toast ' + (level || 'info');
    div.textContent = message;
    els.toastHost.appendChild(div);
    setTimeout(function () {
      div.style.opacity = '0';
      div.style.transition = 'opacity .25s';
      setTimeout(function () { div.remove(); }, 260);
    }, 3200);
  }

  function viewSize() {
    return { w: els.wrap.clientWidth, h: els.wrap.clientHeight };
  }

  function updateStats(overlaps, elapsed) {
    els.statNodes.textContent = '节点 ' + state.nodes.length;
    els.statEdges.textContent = '连线 ' + state.edges.length;
    if (typeof overlaps === 'number') {
      if (overlaps < 0) {
        els.statOverlap.textContent = '重叠段 兜底中';
        els.statOverlap.className = 'bad';
      } else if (overlaps === 0) {
        els.statOverlap.textContent = '重叠段 0';
        els.statOverlap.className = 'ok';
      } else {
        els.statOverlap.textContent = '重叠段 ' + overlaps + '（建议重新路由）';
        els.statOverlap.className = 'bad';
      }
    }
    if (typeof elapsed === 'number' && elapsed >= 0) {
      els.statRouteTime.textContent = '路由 ' + elapsed + ' ms';
    }
  }

  /* ---------------- SVG 渲染 ---------------- */

  function svgEl(tag, attrs) {
    var el = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'text') el.textContent = attrs[k];
        else el.setAttribute(k, attrs[k]);
      });
    }
    return el;
  }

  function pathD(pts) {
    if (!pts || !pts.length) return '';
    var d = 'M' + pts[0].x + ' ' + pts[0].y;
    for (var i = 1; i < pts.length; i++) d += 'L' + pts[i].x + ' ' + pts[i].y;
    return d;
  }

  function renderNode(node) {
    var g = refs.nodes.get(node.id);
    if (!g) {
      g = svgEl('g', { class: 'node-group' });
      g.appendChild(svgEl('rect', { class: 'node-rect' }));
      g.appendChild(svgEl('text', { class: 'node-label' }));
      PORT_SIDES.forEach(function (side) {
        g.appendChild(svgEl('circle', {
          class: 'port',
          r: 4.5,
          'data-side': side
        }));
      });
      g.addEventListener('pointerdown', onNodePointerDown);
      els.nodeLayer.appendChild(g);
      refs.nodes.set(node.id, g);
    }
    g.setAttribute('transform', 'translate(' + node.x + ',' + node.y + ')');
    g.querySelector('.node-rect').setAttribute('width', node.w);
    g.querySelector('.node-rect').setAttribute('height', node.h);
    var label = g.querySelector('.node-label');
    label.setAttribute('x', node.w / 2);
    label.setAttribute('y', node.h / 2);
    label.textContent = node.label;
    var ports = g.querySelectorAll('.port');
    for (var i = 0; i < ports.length; i++) {
      var side = ports[i].getAttribute('data-side');
      var pos = {
        top: [node.w / 2, 0],
        right: [node.w, node.h / 2],
        bottom: [node.w / 2, node.h],
        left: [0, node.h / 2]
      }[side];
      ports[i].setAttribute('cx', pos[0]);
      ports[i].setAttribute('cy', pos[1]);
    }
    g.classList.toggle('selected', state.selectedNode === node.id);
    return g;
  }

  function renderEdge(edge) {
    var wrap = refs.edges.get(edge.id);
    if (!wrap) {
      wrap = svgEl('g', { class: 'edge-wrap' });
      var hit = svgEl('path', { class: 'edge-hit' });
      var path = svgEl('path', {
        class: 'edge-path',
        'marker-end': 'url(#arrow)'
      });
      wrap.appendChild(hit);
      wrap.appendChild(path);
      wrap.addEventListener('pointerdown', function (ev) {
        ev.stopPropagation();
        selectEdge(edge.id);
      });
      els.edgeLayer.appendChild(wrap);
      refs.edges.set(edge.id, wrap);
    }
    var pts = state.paths[edge.id];
    var d = pathD(pts);
    wrap.querySelector('.edge-path').setAttribute('d', d);
    wrap.querySelector('.edge-hit').setAttribute('d', d);
    wrap.classList.toggle('selected', state.selectedEdge === edge.id);
    return wrap;
  }

  function renderAll() {
    var nodeIds = new Set(state.nodes.map(function (n) { return n.id; }));
    var edgeIds = new Set(state.edges.map(function (e) { return e.id; }));

    refs.nodes.forEach(function (g, id) {
      if (!nodeIds.has(id)) { g.remove(); refs.nodes.delete(id); }
    });
    refs.edges.forEach(function (g, id) {
      if (!edgeIds.has(id)) { g.remove(); refs.edges.delete(id); }
    });

    state.nodes.forEach(renderNode);
    state.edges.forEach(renderEdge);
    updateStats(null, null);
  }

  function updatePathD(edgeId, pts) {
    var wrap = refs.edges.get(edgeId);
    if (!wrap) return;
    var d = pathD(pts);
    wrap.querySelector('.edge-path').setAttribute('d', d);
    wrap.querySelector('.edge-hit').setAttribute('d', d);
  }

  function setQuickMode(edgeIds, on) {
    edgeIds.forEach(function (id) {
      var wrap = refs.edges.get(id);
      if (wrap) wrap.classList.toggle('quick', !!on);
    });
  }

  /* ---------------- 对齐线 ---------------- */

  function drawGuides(hitV, hitH) {
    els.guideLayer.textContent = '';
    if (!settings.guides) return;
    if (hitV) {
      els.guideLayer.appendChild(svgEl('line', {
        class: 'guide',
        x1: hitV.x, y1: Math.max(0, hitV.min - 8),
        x2: hitV.x, y2: hitV.max + 8
      }));
    }
    if (hitH) {
      els.guideLayer.appendChild(svgEl('line', {
        class: 'guide',
        x1: Math.max(0, hitH.min - 8), y1: hitH.y,
        x2: hitH.max + 8, y2: hitH.y
      }));
    }
  }

  function clearGuides() {
    els.guideLayer.textContent = '';
  }

  /* ---------------- 选择 ---------------- */

  function findNode(id) {
    for (var i = 0; i < state.nodes.length; i++) {
      if (state.nodes[i].id === id) return state.nodes[i];
    }
    return null;
  }

  function selectNode(id) {
    state.selectedNode = id;
    state.selectedEdge = null;
    state.nodes.forEach(function (n) {
      refs.nodes.get(n.id).classList.toggle('selected', n.id === id);
    });
    refs.edges.forEach(function (g) { g.classList.remove('selected'); });
  }

  function selectEdge(id) {
    state.selectedEdge = id;
    state.selectedNode = null;
    refs.nodes.forEach(function (g) { g.classList.remove('selected'); });
    refs.edges.forEach(function (g, eid) {
      g.classList.toggle('selected', eid === id);
    });
  }

  function clearSelection() {
    state.selectedNode = null;
    state.selectedEdge = null;
    refs.nodes.forEach(function (g) { g.classList.remove('selected'); });
    refs.edges.forEach(function (g) { g.classList.remove('selected'); });
  }

  /* ---------------- 路由调度 ---------------- */

  function edgeAffected(edge, nodeId) {
    return edge.source === nodeId || edge.target === nodeId;
  }

  function scheduleRoute(options) {
    var opts = options || {};
    clearTimeout(routeTimer);
    var token = ++routeToken;
    var delay = opts.immediate ? 0 : (opts.drag ? 60 : 120);

    if (opts.drag) {
      var quick = router.quickRoutes(routePayload());
      Object.keys(quick.paths).forEach(function (id) {
        state.paths[id] = quick.paths[id];
        updatePathD(id, quick.paths[id]);
      });
      setQuickMode(Object.keys(quick.paths), true);
      updateStats(-1, null);
    }

    routeTimer = setTimeout(function () {
      runRoute(token);
    }, delay);
  }

  function routePayload() {
    var v = viewSize();
    return {
      nodes: state.nodes.map(function (n) {
        return { id: n.id, x: n.x, y: n.y, w: n.w, h: n.h };
      }),
      edges: state.edges.map(function (e) {
        return {
          id: e.id, source: e.source, target: e.target,
          fromPort: e.fromPort, toPort: e.toPort
        };
      }),
      grid: settings.grid,
      channel: settings.channel,
      view: v
    };
  }

  function runRoute(token) {
    if (!state.edges.length) {
      updateStats(0, 0);
      return;
    }
    router.route(routePayload()).then(function (result) {
      if (token !== routeToken) return;
      state.paths = Object.assign({}, state.paths, result.paths);
      Object.keys(result.paths).forEach(function (id) {
        updatePathD(id, result.paths[id]);
      });
      setQuickMode(state.edges.map(function (e) { return e.id; }), false);
      updateStats(result.overlaps, result.elapsed);
    }).catch(function (err) {
      if (token !== routeToken) return;
      var quick = router.quickRoutes(routePayload());
      Object.keys(quick.paths).forEach(function (id) {
        state.paths[id] = quick.paths[id];
        updatePathD(id, quick.paths[id]);
      });
      setQuickMode(Object.keys(quick.paths), true);
      updateStats(-1, null);
      toast((err && err.message) || '路由失败，已切换本地兜底连线', 'warn');
    });
  }

  /* ---------------- 节点拖拽（吸附 + 对齐） ---------------- */

  var drag = null;

  function scenePoint(ev) {
    var rect = els.scene.getBoundingClientRect();
    return {
      x: ev.clientX - rect.left,
      y: ev.clientY - rect.top
    };
  }

  function onNodePointerDown(ev) {
    if (ev.button !== 0) return;
    var portSide = ev.target.getAttribute && ev.target.getAttribute('data-side');
    var group = ev.currentTarget;
    var nodeId = null;
    refs.nodes.forEach(function (g, id) { if (g === group) nodeId = id; });
    var node = findNode(nodeId);
    if (!node) return;

    ev.preventDefault();
    els.scene.focus({ preventScroll: true });

    if (portSide) {
      startConnect(ev, node, portSide);
      return;
    }

    selectNode(nodeId);
    var pt = scenePoint(ev);
    drag = {
      node: node,
      startX: pt.x,
      startY: pt.y,
      origX: node.x,
      origY: node.y,
      moved: false
    };
    group.classList.add('dragging');
    try { els.scene.setPointerCapture(ev.pointerId); } catch (e) {}
  }

  function onPointerMove(ev) {
    if (connecting) return onConnectMove(ev);
    if (!drag) return;
    var pt = scenePoint(ev);
    var node = drag.node;
    var dx = pt.x - drag.startX;
    var dy = pt.y - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;

    var rawX = drag.origX + dx;
    var rawY = drag.origY + dy;
    var view = viewSize();
    rawX = Math.min(Math.max(rawX, -node.w + 20), Math.max(view.w - 20, 0));
    rawY = Math.min(Math.max(rawY, -node.h + 20), Math.max(view.h - 20, 0));

    var pos = { x: rawX, y: rawY };
    var hitV = null, hitH = null;

    if (settings.guides) {
      var probe = {
        id: node.id, x: pos.x, y: pos.y, w: node.w, h: node.h,
        cx: pos.x + node.w / 2, cy: pos.y + node.h / 2,
        right: pos.x + node.w, bottom: pos.y + node.h
      };
      var others = state.nodes.filter(function (n) { return n.id !== node.id; });
      var guides = Geo.computeGuides(probe, others, settings.grid / 2 + 2);
      var adjusted = Geo.applyGuides(pos, { w: node.w, h: node.h }, guides, settings.grid / 2 + 2);
      pos.x = adjusted.x;
      pos.y = adjusted.y;
      hitV = adjusted.hitV;
      hitH = adjusted.hitH;
    }

    var snapOn = settings.snap && !ev.shiftKey;
    node.x = snapOn ? Geo.snap(pos.x, settings.grid) : Math.round(pos.x);
    node.y = snapOn ? Geo.snap(pos.y, settings.grid) : Math.round(pos.y);

    renderNode(node);
    drawGuides(hitV, hitH);
    scheduleRoute({ drag: true });
  }

  function onPointerUp(ev) {
    if (connecting) return finishConnect(ev);
    if (!drag) return;
    var group = refs.nodes.get(drag.node.id);
    if (group) group.classList.remove('dragging');
    clearGuides();
    if (drag.moved) scheduleRoute({ immediate: true });
    drag = null;
  }

  /* ---------------- 连线绘制 ---------------- */

  var connecting = null;

  function startConnect(ev, node, side) {
    connecting = {
      source: node,
      fromPort: side,
      pointer: scenePoint(ev)
    };
    els.tempLayer.textContent = '';
    els.tempLayer.appendChild(svgEl('path', { class: 'temp-edge' }));
    try { els.scene.setPointerCapture(ev.pointerId); } catch (e) {}
  }

  function elbowTemp(from, side, to) {
    var s = window.PortAnchor(from, side, settings.channel, 0, 1);
    if (side === 'left' || side === 'right') {
      var mx = (s.x + to.x) / 2;
      return [s, { x: mx, y: s.y }, { x: mx, y: to.y }, to];
    }
    var my = (s.y + to.y) / 2;
    return [s, { x: s.x, y: my }, { x: to.x, y: my }, to];
  }

  function onConnectMove(ev) {
    connecting.pointer = scenePoint(ev);
    var d = pathD(elbowTemp(connecting.source, connecting.fromPort, connecting.pointer));
    els.tempLayer.querySelector('.temp-edge').setAttribute('d', d);
  }

  function hitPort(ev) {
    var el = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!el || !el.classList || !el.classList.contains('port')) return null;
    var group = el.parentNode;
    var nodeId = null;
    refs.nodes.forEach(function (g, id) { if (g === group) nodeId = id; });
    return { nodeId: nodeId, side: el.getAttribute('data-side') };
  }

  function finishConnect(ev) {
    var hit = hitPort(ev);
    var c = connecting;
    connecting = null;
    els.tempLayer.textContent = '';

    if (!hit || !hit.nodeId) return;
    if (hit.nodeId === c.source.id) {
      toast('不支持节点自连，请连接到其他节点', 'warn');
      return;
    }
    var duplicate = state.edges.some(function (e) {
      return e.source === c.source.id && e.target === hit.nodeId &&
        e.fromPort === c.fromPort && e.toPort === hit.side;
    });
    if (duplicate) {
      toast('相同端口之间的连线已存在', 'warn');
      return;
    }

    var edge = {
      id: 'e' + (++edgeSeq),
      source: c.source.id,
      target: hit.nodeId,
      fromPort: c.fromPort,
      toPort: hit.side
    };
    state.edges.push(edge);
    renderAll();
    scheduleRoute({ immediate: true });
    toast('已新增连线', 'info');
  }

  /* ---------------- 工具条与命令 ---------------- */

  function addNode(x, y, label) {
    var node = {
      id: 'n' + (++nodeSeq),
      x: x,
      y: y,
      w: 120,
      h: 56,
      label: label || '节点 ' + nodeSeq
    };
    state.nodes.push(node);
    renderNode(node);
    selectNode(node.id);
    updateStats(null, null);
    return node;
  }

  function deleteSelected() {
    if (state.selectedNode) {
      var id = state.selectedNode;
      state.edges = state.edges.filter(function (e) {
        return e.source !== id && e.target !== id;
      });
      state.nodes = state.nodes.filter(function (n) { return n.id !== id; });
      state.selectedNode = null;
      renderAll();
      scheduleRoute({ immediate: true });
      toast('已删除节点及其连线', 'info');
    } else if (state.selectedEdge) {
      var eid = state.selectedEdge;
      state.edges = state.edges.filter(function (e) { return e.id !== eid; });
      delete state.paths[eid];
      state.selectedEdge = null;
      renderAll();
      updateStats(state.edges.length ? null : 0, null);
      toast('已删除连线', 'info');
    }
  }

  function applyGridVisual() {
    var g = settings.grid;
    els.gridPattern.setAttribute('width', g);
    els.gridPattern.setAttribute('height', g);
    var path = els.gridPattern.querySelector('path');
    path.setAttribute('d', 'M ' + g + ' 0 L 0 0 0 ' + g);
    els.gridRect.style.display = settings.gridVisible ? '' : 'none';
  }

  function loadGraph(graph, options) {
    state.nodes = graph.nodes.slice();
    state.edges = graph.edges.slice();
    state.paths = {};
    state.selectedNode = null;
    state.selectedEdge = null;
    var maxN = 0, maxE = 0;
    state.nodes.forEach(function (n) {
      var m = /^n(\d+)$/.exec(n.id);
      if (m) maxN = Math.max(maxN, Number(m[1]));
    });
    state.edges.forEach(function (e) {
      var m = /^e(\d+)$/.exec(e.id);
      if (m) maxE = Math.max(maxE, Number(m[1]));
    });
    nodeSeq = maxN;
    edgeSeq = maxE;
    refs.nodes.forEach(function (g) { g.remove(); });
    refs.edges.forEach(function (g) { g.remove(); });
    refs.nodes.clear();
    refs.edges.clear();
    renderAll();
    scheduleRoute({ immediate: true });
    if (!options || !options.silent) {
      toast('已加载 ' + state.nodes.length + ' 个节点、' + state.edges.length + ' 条连线', 'info');
    }
  }

  function buildDemo() {
    var specs = [
      { id: 'n1', x: 60, y: 80, w: 120, h: 56, label: '输入' },
      { id: 'n2', x: 280, y: 60, w: 120, h: 56, label: '校验' },
      { id: 'n3', x: 280, y: 200, w: 120, h: 56, label: '缓存' },
      { id: 'n4', x: 500, y: 80, w: 120, h: 56, label: '处理' },
      { id: 'n5', x: 500, y: 220, w: 120, h: 56, label: '日志' },
      { id: 'n6', x: 720, y: 140, w: 120, h: 56, label: '输出' }
    ];
    var edges = [
      { id: 'e1', source: 'n1', target: 'n2', fromPort: 'right', toPort: 'left' },
      { id: 'e2', source: 'n1', target: 'n3', fromPort: 'bottom', toPort: 'left' },
      { id: 'e3', source: 'n2', target: 'n4', fromPort: 'right', toPort: 'left' },
      { id: 'e4', source: 'n3', target: 'n4', fromPort: 'right', toPort: 'bottom' },
      { id: 'e5', source: 'n4', target: 'n5', fromPort: 'bottom', toPort: 'top' },
      { id: 'e6', source: 'n4', target: 'n6', fromPort: 'right', toPort: 'left' },
      { id: 'e7', source: 'n3', target: 'n5', fromPort: 'bottom', toPort: 'left' },
      { id: 'e8', source: 'n5', target: 'n6', fromPort: 'right', toPort: 'bottom' }
    ];
    state.nodes = specs;
    state.edges = edges;
    state.paths = {};
    nodeSeq = 6;
    edgeSeq = 8;
    renderAll();
    scheduleRoute({ immediate: true });
  }

  function buildPerf() {
    var N = 10, M = 10;
    var nodes = [];
    var edges = [];
    var nid = function (r, c) { return 'n' + (r * N + c + 100); };
    for (var r = 0; r < M; r++) {
      for (var c = 0; c < N; c++) {
        nodes.push({
          id: nid(r, c),
          x: 40 + c * 100,
          y: 60 + r * 90 + (c % 2) * 10,
          w: 60,
          h: 40,
          label: ''
        });
      }
    }
    var k = 0;
    for (var row = 0; row < M; row++) {
      for (var col = 0; col < N - 1; col++) {
        edges.push({
          id: 'pe' + (++k),
          source: nid(row, col),
          target: nid(row, col + 1),
          fromPort: 'right',
          toPort: 'left'
        });
      }
      if (row < M - 1) {
        edges.push({
          id: 'pe' + (++k),
          source: nid(row, N - 1),
          target: nid(row + 1, 0),
          fromPort: 'bottom',
          toPort: 'left'
        });
      }
    }
    loadGraph({ nodes: nodes, edges: edges }, { silent: true });
    toast('压力测试：' + nodes.length + ' 节点 / ' + edges.length + ' 连线', 'info');
  }

  /* ---------------- 事件绑定与启动 ---------------- */

  function exportState() {
    return {
      nodes: state.nodes,
      edges: state.edges,
      paths: state.paths
    };
  }

  function doExportPng() {
    if (!state.nodes.length) { toast('画布为空，无可导出内容', 'warn'); return; }
    Exporter.exportPng(exportState(), {
      grid: settings.grid,
      showGrid: settings.gridVisible,
      scale: 2
    }).then(function () {
      toast('PNG 已导出', 'info');
    }).catch(function (err) {
      toast('PNG 导出失败：' + (err.message || err), 'error');
    });
  }

  function doExportSvg() {
    if (!state.nodes.length) { toast('画布为空，无可导出内容', 'warn'); return; }
    try {
      Exporter.exportSvg(exportState(), {
        grid: settings.grid,
        showGrid: settings.gridVisible
      });
      toast('SVG 已导出', 'info');
    } catch (err) {
      toast('SVG 导出失败：' + (err.message || err), 'error');
    }
  }

  function doExportJson() {
    if (!state.nodes.length) { toast('画布为空，无可导出内容', 'warn'); return; }
    try {
      Exporter.exportJson(exportState());
      toast('JSON 已导出', 'info');
    } catch (err) {
      toast('JSON 导出失败：' + (err.message || err), 'error');
    }
  }

  function onImportFile(ev) {
    var file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast('文件超过 5MB 限制', 'error');
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(String(reader.result));
        var graph = Exporter.validateGraph(data);
        loadGraph(graph);
      } catch (err) {
        toast('导入失败：' + (err.message || err), 'error');
      }
    };
    reader.onerror = function () { toast('文件读取失败', 'error'); };
    reader.readAsText(file);
  }

  function bindEvents() {
    els.scene.addEventListener('pointermove', onPointerMove);
    els.scene.addEventListener('pointerup', onPointerUp);
    els.scene.addEventListener('pointercancel', onPointerUp);
    els.scene.addEventListener('pointerdown', function (ev) {
      if (ev.target === els.scene || ev.target === els.gridRect) clearSelection();
    });
    els.scene.addEventListener('keydown', function (ev) {
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        ev.preventDefault();
        deleteSelected();
      }
    });

    els.snapToggle.addEventListener('change', function () {
      settings.snap = els.snapToggle.checked;
    });
    els.guideToggle.addEventListener('change', function () {
      settings.guides = els.guideToggle.checked;
      if (!settings.guides) clearGuides();
    });
    els.gridToggle.addEventListener('change', function () {
      settings.gridVisible = els.gridToggle.checked;
      applyGridVisual();
    });
    els.gridSize.addEventListener('change', function () {
      settings.grid = Number(els.gridSize.value);
      applyGridVisual();
      scheduleRoute({ immediate: true });
    });
    els.channel.addEventListener('change', function () {
      settings.channel = Number(els.channel.value);
      scheduleRoute({ immediate: true });
    });

    document.getElementById('addNodeBtn').addEventListener('click', function () {
      var v = viewSize();
      var x = Geo.snap(60 + Math.random() * Math.max(v.w - 200, 80), settings.grid);
      var y = Geo.snap(60 + Math.random() * Math.max(v.h - 160, 80), settings.grid);
      addNode(x, y);
    });
    document.getElementById('perfBtn').addEventListener('click', buildPerf);
    document.getElementById('rerouteBtn').addEventListener('click', function () {
      scheduleRoute({ immediate: true });
      toast('已触发重新路由', 'info');
    });
    document.getElementById('exportSvgBtn').addEventListener('click', doExportSvg);
    document.getElementById('exportPngBtn').addEventListener('click', doExportPng);
    document.getElementById('exportJsonBtn').addEventListener('click', doExportJson);
    document.getElementById('importJsonInput').addEventListener('change', onImportFile);

    window.addEventListener('error', function (ev) {
      toast('运行异常：' + (ev.message || '未知错误'), 'error');
    });
    window.addEventListener('unhandledrejection', function (ev) {
      var reason = ev.reason && ev.reason.message ? ev.reason.message : String(ev.reason);
      toast('异步任务异常：' + reason, 'error');
    });
  }

  var fpsLast = performance.now();
  var fpsFrames = 0;

  function fpsLoop(now) {
    fpsFrames++;
    if (now - fpsLast >= 1000) {
      els.statFps.textContent = 'FPS ' + fpsFrames;
      fpsFrames = 0;
      fpsLast = now;
    }
    requestAnimationFrame(fpsLoop);
  }

  function init() {
    settings.gridVisible = true;
    applyGridVisual();
    bindEvents();
    buildDemo();
    updateStats(null, null);
    requestAnimationFrame(fpsLoop);
    if (router.broken) {
      setTimeout(function () {
        toast('路由 Worker 初始化失败，已使用主线程兜底路由', 'warn');
      }, 300);
    }
  }

  init();
})();
