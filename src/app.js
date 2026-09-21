// 主应用：画布交互（拖拽/连线/缩放/平移）、渲染调度、路由与导出接线。
import { snapMoving } from './snap.js';
import { RouterClient } from './router-client.js';
import { exportSVG, exportPNG, exportJSON, importJSON } from './exporter.js';
import { toast, installGlobalHandlers } from './toast.js';

installGlobalHandlers();

const GRID = 20;
const NODE_W = 140;
const NODE_H = 56;
const COLORS = ['#4f8ef7', '#22b07d', '#f2a93b', '#e05d5d', '#8b6ff0', '#0ea5b7'];
const NS = 'http://www.w3.org/2000/svg';

const svg = document.getElementById('canvas');
const nodeLayer = document.getElementById('node-layer');
const edgeLayer = document.getElementById('edge-layer');
const overlayLayer = document.getElementById('overlay-layer');
const gridRect = document.getElementById('grid-rect');
const hint = document.getElementById('hint');

const state = {
  nodes: [],
  edges: [],
  nodeSeq: 1,
  edgeSeq: 1,
  tool: 'select',        // select | connect
  connectFrom: null,
  selected: null,        // { type: 'node'|'edge', id }
  snap: true,
  showGrid: true,
};
const routes = new Map(); // edgeId -> { points, degraded }
const view = { x: 0, y: 0, w: 1600, h: 900 };
let activeGuides = [];
let dragState = null;

// ---------- 工具 ----------
function el(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
}
function nodeById(id) { return state.nodes.find((n) => n.id === id); }
function toScene(evt) {
  const r = svg.getBoundingClientRect();
  return {
    x: view.x + ((evt.clientX - r.left) / r.width) * view.w,
    y: view.y + ((evt.clientY - r.top) / r.height) * view.h,
  };
}
function syncViewAspect() {
  const r = svg.getBoundingClientRect();
  if (r.width > 0 && r.height > 0) view.h = (view.w * r.height) / r.width;
}
function applyView() {
  svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  gridRect.setAttribute('x', String(view.x - view.w));
  gridRect.setAttribute('y', String(view.y - view.h));
  gridRect.setAttribute('width', String(view.w * 3));
  gridRect.setAttribute('height', String(view.h * 3));
}

// ---------- 渲染 ----------
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function pathD(points) {
  return points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ');
}

function previewPoints(edge) {
  const a = nodeById(edge.from);
  const b = nodeById(edge.to);
  if (!a || !b) return [];
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
  const bx = b.x + b.w / 2, by = b.y + b.h / 2;
  const dx = bx - ax, dy = by - ay;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const sx = dx >= 0 ? a.x + a.w : a.x;
    const tx = dx >= 0 ? b.x : b.x + b.w;
    const mx = (sx + tx) / 2;
    return [{ x: sx, y: ay }, { x: mx, y: ay }, { x: mx, y: by }, { x: tx, y: by }];
  }
  const sy = dy >= 0 ? a.y + a.h : a.y;
  const ty = dy >= 0 ? b.y : b.y + b.h;
  const my = (sy + ty) / 2;
  return [{ x: ax, y: sy }, { x: ax, y: my }, { x: bx, y: my }, { x: bx, y: ty }];
}

function render() {
  renderEdges();
  renderNodes();
  renderOverlay();
}

function renderEdges() {
  edgeLayer.replaceChildren();
  for (const e of state.edges) {
    const route = routes.get(e.id);
    const points = route ? route.points : previewPoints(e);
    if (points.length < 2) continue;
    const isSel = state.selected && state.selected.type === 'edge' && state.selected.id === e.id;
    const path = el('path', {
      d: pathD(points),
      class: `edge${isSel ? ' selected' : ''}${route && route.degraded ? ' degraded' : ''}`,
      'marker-end': 'url(#arrow)',
      'data-id': e.id,
    });
    edgeLayer.appendChild(path);
  }
}

function renderNodes() {
  nodeLayer.replaceChildren();
  for (const n of state.nodes) {
    const g = el('g', { class: 'node', 'data-id': n.id, transform: `translate(${n.x} ${n.y})` });
    const isSel = state.selected && state.selected.type === 'node' && state.selected.id === n.id;
    const rect = el('rect', {
      width: n.w, height: n.h, rx: 8,
      class: `node-rect${isSel ? ' selected' : ''}${state.connectFrom === n.id ? ' connect-from' : ''}`,
      fill: n.color,
    });
    const text = el('text', { x: n.w / 2, y: n.h / 2, class: 'node-label' });
    text.textContent = n.label;
    g.append(rect, text);
    nodeLayer.appendChild(g);
  }
}

function renderOverlay() {
  overlayLayer.replaceChildren();
  for (const g of activeGuides) {
    const line = g.axis === 'v'
      ? el('line', { x1: g.pos, y1: view.y - view.h, x2: g.pos, y2: view.y + view.h * 2, class: 'guide' })
      : el('line', { x1: view.x - view.w, y1: g.pos, x2: view.x + view.w * 2, y2: g.pos, class: 'guide' });
    overlayLayer.appendChild(line);
  }
}

// ---------- 路由 ----------
const router = new RouterClient({
  onResult({ routes: r, warnings }) {
    routes.clear();
    for (const [id, v] of r) routes.set(id, v);
    for (const w of warnings) toast(w, 'warn');
    scheduleRender();
  },
  onWarning(msg) { toast(msg, 'warn'); },
});

let routeTimer = 0;
function scheduleRoute(delay = 60) {
  clearTimeout(routeTimer);
  routeTimer = setTimeout(() => {
    try {
      router.request(
        state.nodes.map((n) => ({ ...n })),
        state.edges.map((e) => ({ ...e })),
      );
    } catch (err) {
      toast(`路由请求失败：${err.message}`, 'error');
    }
  }, delay);
}

// ---------- 状态操作 ----------
function addNode(x, y) {
  const idx = state.nodeSeq++;
  state.nodes.push({
    id: `n${idx}`,
    x: Math.round(x / GRID) * GRID,
    y: Math.round(y / GRID) * GRID,
    w: NODE_W, h: NODE_H,
    label: `节点 ${idx}`,
    color: COLORS[(idx - 1) % COLORS.length],
  });
  scheduleRender();
  scheduleRoute();
}

function deleteSelected() {
  if (!state.selected) { toast('请先选中一个节点或连线', 'info'); return; }
  const { type, id } = state.selected;
  if (type === 'node') {
    state.nodes = state.nodes.filter((n) => n.id !== id);
    state.edges = state.edges.filter((e) => e.from !== id && e.to !== id);
    routes.forEach((_, eid) => {
      if (!state.edges.some((e) => e.id === eid)) routes.delete(eid);
    });
  } else {
    state.edges = state.edges.filter((e) => e.id !== id);
    routes.delete(id);
  }
  state.selected = null;
  scheduleRender();
  scheduleRoute(0);
}

function setTool(tool) {
  state.tool = tool;
  state.connectFrom = null;
  document.getElementById('btn-connect').classList.toggle('active', tool === 'connect');
  hint.textContent = tool === 'connect'
    ? '连线模式：依次点击两个节点创建连线，Esc 退出。'
    : '提示：拖拽移动节点（自动网格吸附与对齐）；点击选中，Delete 删除；滚轮缩放，拖拽空白平移。';
  scheduleRender();
}

// ---------- 交互 ----------
function onNodePointerDown(evt, node) {
  evt.stopPropagation();
  if (state.tool === 'connect') {
    if (!state.connectFrom) {
      state.connectFrom = node.id;
      toast(`已选择起点「${node.label}」，请点击目标节点`, 'info');
    } else if (state.connectFrom === node.id) {
      toast('不能连接到自身', 'warn');
    } else {
      const exists = state.edges.some((e) => e.from === state.connectFrom && e.to === node.id);
      if (exists) {
        toast('两个节点之间已存在连线', 'warn');
      } else {
        state.edges.push({ id: `e${state.edgeSeq++}`, from: state.connectFrom, to: node.id });
        toast('连线已创建', 'info');
        scheduleRoute(0);
      }
      state.connectFrom = null;
    }
    scheduleRender();
    return;
  }
  state.selected = { type: 'node', id: node.id };
  const start = toScene(evt);
  dragState = { kind: 'node', node, startX: node.x, startY: node.y, px: start.x, py: start.y, moved: false };
  svg.setPointerCapture(evt.pointerId);
  scheduleRender();
}

function onEdgePointerDown(evt, edge) {
  evt.stopPropagation();
  state.selected = { type: 'edge', id: edge.id };
  scheduleRender();
}

svg.addEventListener('pointerdown', (evt) => {
  const nodeG = evt.target.closest && evt.target.closest('g.node');
  if (nodeG) {
    const node = nodeById(nodeG.dataset.id);
    if (node) onNodePointerDown(evt, node);
    return;
  }
  const edgePath = evt.target.closest && evt.target.closest('path.edge');
  if (edgePath) {
    const edge = state.edges.find((e) => e.id === edgePath.dataset.id);
    if (edge) onEdgePointerDown(evt, edge);
    return;
  }
  // 空白：开始平移
  state.selected = null;
  const start = toScene(evt);
  dragState = { kind: 'pan', vx: view.x, vy: view.y, px: start.x, py: start.y };
  svg.setPointerCapture(evt.pointerId);
  scheduleRender();
});

svg.addEventListener('pointermove', (evt) => {
  if (!dragState) return;
  const p = toScene(evt);
  if (dragState.kind === 'pan') {
    view.x = dragState.vx - (p.x - dragState.px);
    view.y = dragState.vy - (p.y - dragState.py);
    applyView();
    return;
  }
  const node = dragState.node;
  let nx = dragState.startX + (p.x - dragState.px);
  let ny = dragState.startY + (p.y - dragState.py);
  if (state.snap) {
    const others = state.nodes.filter((n) => n.id !== node.id);
    const snapped = snapMoving({ x: nx, y: ny, w: node.w, h: node.h }, others, {
      grid: GRID, threshold: 6, useGrid: true, useAlign: true,
    });
    nx = snapped.x; ny = snapped.y;
    activeGuides = snapped.guides;
  } else {
    activeGuides = [];
  }
  node.x = nx; node.y = ny;
  dragState.moved = true;
  scheduleRender();
  scheduleRoute(150); // 拖动中节流路由；松手后立即全量路由
});

svg.addEventListener('pointerup', () => {
  if (dragState && dragState.kind === 'node' && dragState.moved) scheduleRoute(0);
  dragState = null;
  activeGuides = [];
  scheduleRender();
});

svg.addEventListener('wheel', (evt) => {
  evt.preventDefault();
  const factor = evt.deltaY > 0 ? 1.12 : 1 / 1.12;
  const newW = Math.min(8000, Math.max(240, view.w * factor));
  const p = toScene(evt);
  const ratio = newW / view.w;
  view.x = p.x - (p.x - view.x) * ratio;
  view.y = p.y - (p.y - view.y) * ratio;
  view.w = newW;
  syncViewAspect();
  applyView();
}, { passive: false });

window.addEventListener('keydown', (evt) => {
  if (evt.key === 'Delete' || evt.key === 'Backspace') {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    deleteSelected();
  } else if (evt.key === 'Escape') {
    setTool('select');
  }
});

window.addEventListener('resize', () => { syncViewAspect(); applyView(); });

// ---------- 工具栏 ----------
function bind(id, fn) {
  document.getElementById(id).addEventListener('click', () => {
    try { fn(); } catch (err) { toast(`操作失败：${err.message}`, 'error'); }
  });
}

bind('btn-add', () => {
  addNode(view.x + view.w / 2 - NODE_W / 2 + (Math.random() * 120 - 60),
          view.y + view.h / 2 - NODE_H / 2 + (Math.random() * 120 - 60));
});
bind('btn-connect', () => setTool(state.tool === 'connect' ? 'select' : 'connect'));
bind('btn-delete', () => deleteSelected());
bind('btn-export-svg', () => { exportSVG(svg, state, routes); toast('SVG 已导出', 'info'); });
bind('btn-export-png', async () => { await exportPNG(svg, state, routes); toast('PNG 已导出', 'info'); });
bind('btn-export-json', () => { exportJSON(state, routes); toast('JSON 已导出', 'info'); });
bind('btn-import-json', () => document.getElementById('file-import').click());

document.getElementById('file-import').addEventListener('change', async (evt) => {
  const file = evt.target.files && evt.target.files[0];
  evt.target.value = '';
  if (!file) return;
  try {
    const { nodes, edges, skipped } = await importJSON(file);
    state.nodes = nodes;
    state.edges = edges;
    state.nodeSeq = nodes.length + 1;
    state.edgeSeq = edges.length + 1;
    state.selected = null;
    routes.clear();
    if (skipped.length) toast(`已跳过 ${skipped.length} 条非法连线：${skipped.join(', ')}`, 'warn');
    toast(`导入成功：${nodes.length} 个节点，${edges.length} 条连线`, 'info');
    scheduleRender();
    scheduleRoute(0);
  } catch (err) {
    toast(`导入失败：${err.message}`, 'error');
  }
});

document.getElementById('chk-snap').addEventListener('change', (evt) => { state.snap = evt.target.checked; });
document.getElementById('chk-grid').addEventListener('change', (evt) => {
  state.showGrid = evt.target.checked;
  gridRect.style.display = state.showGrid ? '' : 'none';
});

// ---------- 初始示例 ----------
function seed() {
  addNode(120, 120);
  addNode(420, 100);
  addNode(420, 300);
  addNode(760, 200);
  state.edges.push(
    { id: `e${state.edgeSeq++}`, from: 'n1', to: 'n2' },
    { id: `e${state.edgeSeq++}`, from: 'n1', to: 'n3' },
    { id: `e${state.edgeSeq++}`, from: 'n2', to: 'n4' },
    { id: `e${state.edgeSeq++}`, from: 'n3', to: 'n4' },
  );
}

syncViewAspect();
applyView();
seed();
setTool('select');
scheduleRoute(0);
