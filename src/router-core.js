// 正交路由核心：网格 A* + 障碍避让 + 连线去重叠。
// 纯函数模块，同时被 Web Worker、主线程降级方案和 Node 测试使用。

export const DEFAULTS = {
  cell: 10,        // 路由网格单元大小 (px)
  margin: 16,      // 节点障碍外扩距离 (px)
  stub: 20,        // 端口引出线长度 (px)，需大于 margin
  boundsPad: 100,  // 路由区域相对内容的外扩 (px)
  turnPenalty: 4,  // 转弯惩罚，减少弯折
  usedPenalty: 60, // 软模式下复用已占用单元的惩罚
  maxCells: 1200000,
};

const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];
const SIDE_DIR = { right: 0, bottom: 1, left: 2, top: 3 };

export function routeAll(nodes, edges, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const warnings = [];
  const routes = new Map();
  if (!edges.length) return { routes, warnings };
  if (!nodes.length) {
    warnings.push('没有节点，无法路由');
    return { routes, warnings };
  }

  // ---- 路由区域与网格 ----
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
  }
  minX -= opts.boundsPad; minY -= opts.boundsPad;
  maxX += opts.boundsPad; maxY += opts.boundsPad;

  let cell = opts.cell;
  const estCells = ((maxX - minX) / cell) * ((maxY - minY) / cell);
  if (estCells > opts.maxCells) {
    cell = Math.ceil(Math.sqrt(((maxX - minX) * (maxY - minY)) / opts.maxCells));
    warnings.push(`路由区域过大，网格单元已自动调整为 ${cell}px`);
  }
  const originX = Math.floor(minX / cell) * cell;
  const originY = Math.floor(minY / cell) * cell;
  const cols = Math.max(1, Math.ceil((maxX - originX) / cell));
  const rows = Math.max(1, Math.ceil((maxY - originY) / cell));
  const size = cols * rows;

  const blocked = new Uint8Array(size); // 1 = 节点障碍
  const used = new Uint8Array(size);    // 1 = 已被先路由的连线占用

  const idx = (i, j) => j * cols + i;
  const inGrid = (i, j) => i >= 0 && j >= 0 && i < cols && j < rows;
  const cx = (i) => originX + i * cell + cell / 2;
  const cy = (j) => originY + j * cell + cell / 2;
  const ci = (x) => Math.floor((x - originX) / cell);
  const cj = (y) => Math.floor((y - originY) / cell);

  // 按“单元中心落在膨胀区内”标记障碍，避免量化误差多圈一层
  const cellRange = (lo, hi, origin, count) => [
    Math.max(0, Math.ceil((lo - origin - cell / 2 - 1e-9) / cell)),
    Math.min(count - 1, Math.floor((hi - origin - cell / 2 + 1e-9) / cell)),
  ];
  for (const n of nodes) {
    const [i0, i1] = cellRange(n.x - opts.margin, n.x + n.w + opts.margin, originX, cols);
    const [j0, j1] = cellRange(n.y - opts.margin, n.y + n.h + opts.margin, originY, rows);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) blocked[idx(i, j)] = 1;
  }

  // ---- 端口分配（同一侧面多条边按车道错开，避免端口处重叠）----
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const laneCount = new Map();

  function chooseSides(a, b) {
    const dx = b.x + b.w / 2 - (a.x + a.w / 2);
    const dy = b.y + b.h / 2 - (a.y + a.h / 2);
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ['right', 'left'] : ['left', 'right'];
    return dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
  }

  function portPoint(n, side) {
    const key = `${n.id}:${side}`;
    const k = laneCount.get(key) || 0;
    laneCount.set(key, k + 1);
    const seq = [0];
    for (let s = 1; s <= 8; s++) seq.push(s, -s);
    const lane = seq[k % seq.length] * 2; // 车道间距 2 个网格
    if (side === 'left' || side === 'right') {
      const x = side === 'left' ? n.x : n.x + n.w;
      let j = Math.round((n.y + n.h / 2 - originY) / cell - 0.5) + lane;
      j = Math.max(cj(n.y + 4), Math.min(cj(n.y + n.h - 4), j));
      return { x, y: cy(j), i: ci(x), j, dir: SIDE_DIR[side], node: n };
    }
    const y = side === 'top' ? n.y : n.y + n.h;
    let i = Math.round((n.x + n.w / 2 - originX) / cell - 0.5) + lane;
    i = Math.max(ci(n.x + 4), Math.min(ci(n.x + n.w - 4), i));
    return { x: cx(i), y, i, j: cj(y), dir: SIDE_DIR[side], node: n };
  }

  // 单元中心是否位于端口所属节点自身的膨胀区内（引出线允许穿过自身膨胀区）
  function insideOwnInflated(port, i, j) {
    const n = port.node;
    const x = cx(i), y = cy(j);
    return x >= n.x - opts.margin - 1e-9 && x <= n.x + n.w + opts.margin + 1e-9 &&
           y >= n.y - opts.margin - 1e-9 && y <= n.y + n.h + opts.margin + 1e-9;
  }

  // 从端口沿朝向走 stub 距离；遇他人障碍即停（不可穿墙）
  function stubEndCell(port) {
    const steps = Math.max(1, Math.round(opts.stub / cell));
    let i = port.i, j = port.j;
    for (let s = 1; s <= steps; s++) {
      const ni = port.i + DX[port.dir] * s;
      const nj = port.j + DY[port.dir] * s;
      if (!inGrid(ni, nj)) break;
      if (blocked[idx(ni, nj)] && !insideOwnInflated(port, ni, nj)) break;
      i = ni; j = nj;
    }
    return [i, j];
  }

  // 引出端点是否可作为 A* 起终点（被他人障碍封死则不可）
  function cellUsable(port, i, j) {
    return !blocked[idx(i, j)] || insideOwnInflated(port, i, j);
  }

  // ---- A*（状态 = 单元 × 方向，带转弯惩罚）----
  const gScore = new Float64Array(size * 4);
  const cameFrom = new Int32Array(size * 4);
  const closed = new Uint8Array(size * 4);
  const heapKeys = [];
  const heapVals = [];

  function heapPush(v, k) {
    heapVals.push(v); heapKeys.push(k);
    let c = heapVals.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heapKeys[p] <= heapKeys[c]) break;
      swap(p, c); c = p;
    }
  }
  function heapPop() {
    const top = heapVals[0];
    const lv = heapVals.pop(), lk = heapKeys.pop();
    if (heapVals.length) {
      heapVals[0] = lv; heapKeys[0] = lk;
      let p = 0;
      for (;;) {
        let s = p;
        const l = p * 2 + 1, r = l + 1;
        if (l < heapKeys.length && heapKeys[l] < heapKeys[s]) s = l;
        if (r < heapKeys.length && heapKeys[r] < heapKeys[s]) s = r;
        if (s === p) break;
        swap(p, s); p = s;
      }
    }
    return top;
  }
  function swap(a, b) {
    [heapVals[a], heapVals[b]] = [heapVals[b], heapVals[a]];
    [heapKeys[a], heapKeys[b]] = [heapKeys[b], heapKeys[a]];
  }

  function astar(start, goal, soft) {
    gScore.fill(Infinity); cameFrom.fill(-1); closed.fill(0);
    heapKeys.length = 0; heapVals.length = 0;
    const [si, sj, sd] = start;
    const [gi, gj] = goal;
    const startState = idx(si, sj) * 4 + sd;
    gScore[startState] = 0;
    heapPush(startState, Math.abs(si - gi) + Math.abs(sj - gj));
    let expansions = 0;
    const maxExpansions = size * 4;
    while (heapVals.length) {
      const state = heapPop();
      if (closed[state]) continue;
      closed[state] = 1;
      const cellIdx = state >> 2;
      const dir = state & 3;
      const i = cellIdx % cols, j = (cellIdx / cols) | 0;
      if (i === gi && j === gj) {
        const cells = [];
        let s = state;
        while (s !== -1) { cells.push(s >> 2); s = cameFrom[s]; }
        cells.reverse();
        return cells;
      }
      if (++expansions > maxExpansions) return null;
      const g0 = gScore[state];
      for (let d = 0; d < 4; d++) {
        const ni = i + DX[d], nj = j + DY[d];
        if (!inGrid(ni, nj)) continue;
        const c = idx(ni, nj);
        // 终点单元允许进入（它可能位于目标节点自身的膨胀区 / 引出线走廊内）
        if (blocked[c] && !(ni === gi && nj === gj)) continue;
        if (used[c] && !soft) continue;
        const cost = 1 + (d !== dir ? opts.turnPenalty : 0) + (soft && used[c] ? opts.usedPenalty : 0);
        const ns = c * 4 + d;
        const ng = g0 + cost;
        if (ng < gScore[ns]) {
          gScore[ns] = ng;
          cameFrom[ns] = state;
          heapPush(ns, ng + Math.abs(ni - gi) + Math.abs(nj - gj));
        }
      }
    }
    return null;
  }

  // ---- 组装与标记 ----
  function markLine(i0, j0, i1, j1) {
    const di = Math.sign(i1 - i0), dj = Math.sign(j1 - j0);
    let i = i0, j = j0;
    for (;;) {
      if (inGrid(i, j)) used[idx(i, j)] = 1;
      if (i === i1 && j === j1) break;
      i += di; j += dj;
    }
  }

  function simplify(pts) {
    const out = [];
    for (const p of pts) {
      const last = out[out.length - 1];
      if (last && last.x === p.x && last.y === p.y) continue;
      out.push(p);
    }
    let k = 1;
    while (k + 1 < out.length) {
      const a = out[k - 1], b = out[k], c = out[k + 1];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (cross === 0) out.splice(k, 1); else k++;
    }
    return out;
  }

  function fallbackPath(pa, pb) {
    const sa = { x: pa.x + DX[pa.dir] * opts.stub, y: pa.y + DY[pa.dir] * opts.stub };
    const sb = { x: pb.x + DX[pb.dir] * opts.stub, y: pb.y + DY[pb.dir] * opts.stub };
    const pts = [{ x: pa.x, y: pa.y }, sa];
    if (sa.x !== sb.x && sa.y !== sb.y) pts.push({ x: sb.x, y: sa.y });
    pts.push(sb, { x: pb.x, y: pb.y });
    return simplify(pts);
  }

  // ---- 预处理端口 ----
  const prepared = [];
  for (const e of edges) {
    const a = nodeById.get(e.from);
    const b = nodeById.get(e.to);
    if (!a || !b) { warnings.push(`连线 ${e.id} 引用了不存在的节点，已跳过`); continue; }
    if (a.id === b.id) { warnings.push(`连线 ${e.id} 是自环，已跳过`); continue; }
    const [sa, sb] = chooseSides(a, b);
    prepared.push({ e, pa: portPoint(a, sa), pb: portPoint(b, sb) });
  }
  prepared.sort((p, q) =>
    (Math.abs(p.pa.x - p.pb.x) + Math.abs(p.pa.y - p.pb.y)) -
    (Math.abs(q.pa.x - q.pb.x) + Math.abs(q.pa.y - q.pb.y)));

  // ---- 逐条路由：严格模式（不重叠）→ 软模式（允许高代价复用）→ 降级直线 ----
  for (const { e, pa, pb } of prepared) {
    const start = stubEndCell(pa);
    const goal = stubEndCell(pb);
    const usable = cellUsable(pa, start[0], start[1]) && cellUsable(pb, goal[0], goal[1]);
    let cells = null;
    if (usable) {
      cells = astar([start[0], start[1], pa.dir], goal, false);
      if (!cells) cells = astar([start[0], start[1], pa.dir], goal, true);
    }
    let points;
    let degraded = false;
    if (cells) {
      points = [{ x: pa.x, y: pa.y }];
      for (const c of cells) points.push({ x: cx(c % cols), y: cy((c / cols) | 0) });
      points.push({ x: pb.x, y: pb.y });
      points = simplify(points);
      markLine(pa.i, pa.j, start[0], start[1]);
      for (let k = 1; k < cells.length; k++) {
        const a = cells[k - 1], b = cells[k];
        markLine(a % cols, (a / cols) | 0, b % cols, (b / cols) | 0);
      }
      markLine(goal[0], goal[1], pb.i, pb.j);
    } else {
      degraded = true;
      warnings.push(`连线 ${e.id} 找不到无遮挡路径，已降级为简单折线`);
      points = fallbackPath(pa, pb);
    }
    routes.set(e.id, { points, degraded });
  }
  return { routes, warnings };
}
