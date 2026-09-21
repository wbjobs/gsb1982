/* 正交路由 Web Worker
 * 栅格 A*：节点为障碍（按通道宽度膨胀），通道占用代价惩罚 => 连线不重叠。
 * 协议：
 *   入 { type:'route', id, nodes:[{id,x,y,w,h}], edges:[{id,source,target,fromPort,toPort}],
 *        grid, channel, onlyIds?:string[], view:{w,h} }
 *   出 { type:'routes', id, paths:{edgeId:[{x,y}...]}, overlaps:number, elapsed:number }
 *   出 { type:'error', id, message }
 */
'use strict';

var DIRS = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 }
];

function nodeRect(node, pad) {
  return {
    x0: node.x - pad,
    y0: node.y - pad,
    x1: node.x + node.w + pad,
    y1: node.y + node.h + pad
  };
}

function portAnchor(node, side, channel, index, total) {
  var offset = 0;
  if (total > 1) {
    // 同一端口多连线：沿边缘扇出，保证接入段互不重合
    var span = side === 'top' || side === 'bottom' ? node.w : node.h;
    var usable = Math.max(span - 12, channel);
    offset = (index - (total - 1) / 2) * Math.min(usable / Math.max(total - 1, 1), channel);
  }
  if (side === 'top') return { x: node.x + node.w / 2 + offset, y: node.y };
  if (side === 'bottom') return { x: node.x + node.w / 2 + offset, y: node.y + node.h };
  if (side === 'left') return { x: node.x, y: node.y + node.h / 2 + offset };
  return { x: node.x + node.w, y: node.y + node.h / 2 + offset };
}

var outward = { right: [1, 0], left: [-1, 0], bottom: [0, 1], top: [0, -1] };

function portEntry(node, side, channel, g, index, total) {
  var p = portAnchor(node, side, channel, index, total);
  var v = outward[side];
  var gy = Math.round(p.y / g);
  var gx = Math.round(p.x / g);
  var sx, sy;
  // 入口单元距节点边界 channel + 1 个网格，保证接入段之间可错行
  var push = Math.ceil(channel / g) + 1;
  if (side === 'right') {
    sx = Math.ceil((node.x + node.w) / g) + push;
    sy = gy;
  } else if (side === 'left') {
    sx = Math.floor(node.x / g) - push;
    sy = gy;
  } else if (side === 'bottom') {
    sx = gx;
    sy = Math.ceil((node.y + node.h) / g) + push;
  } else {
    sx = gx;
    sy = Math.floor(node.y / g) - push;
  }
  return { port: p, vx: v[0], vy: v[1], gx: sx, gy: sy };
}

function buildBlocked(nodes, startEntry, endEntry, inflatePad, g, minX, minY, cols, rows) {
  var blocked = new Uint8Array(cols * rows);
  for (var i = 0; i < nodes.length; i++) {
    var r = nodeRect(nodes[i], inflatePad);
    var x0 = Math.max(0, Math.ceil((r.x0 - minX) / g));
    var x1 = Math.min(cols - 1, Math.floor((r.x1 - minX) / g));
    var y0 = Math.max(0, Math.ceil((r.y0 - minY) / g));
    var y1 = Math.min(rows - 1, Math.floor((r.y1 - minY) / g));
    for (var y = y0; y <= y1; y++) {
      var rowBase = y * cols;
      for (var x = x0; x <= x1; x++) blocked[rowBase + x] = 1;
    }
  }
  clearCorridor(blocked, startEntry, g, minX, minY, cols, rows);
  clearCorridor(blocked, endEntry, g, minX, minY, cols, rows);
  // 起/终点单元可能落在自身膨胀区内，必须强制放行
  var ox = Math.round(minX / g);
  var oy = Math.round(minY / g);
  blocked[clamp(startEntry.gy - oy, 0, rows - 1) * cols +
          clamp(startEntry.gx - ox, 0, cols - 1)] = 0;
  blocked[clamp(endEntry.gy - oy, 0, rows - 1) * cols +
          clamp(endEntry.gx - ox, 0, cols - 1)] = 0;
  return blocked;
}

/* 从端口到栅格入口点的射线走廊必须放行，否则起点/终点被障碍包住。 */
function clearCorridor(blocked, entry, g, minX, minY, cols, rows) {
  var px = Math.round(entry.port.x / g);
  var py = Math.round(entry.port.y / g);
  var ex = entry.gx;
  var ey = entry.gy;
  var half = 0;
  var loX = clamp(Math.min(px, ex) - half, 0, cols - 1);
  var hiX = clamp(Math.max(px, ex) + half, 0, cols - 1);
  var loY = clamp(Math.min(py, ey) - half, 0, rows - 1);
  var hiY = clamp(Math.max(py, ey) + half, 0, rows - 1);
  for (var y = loY; y <= hiY; y++) {
    for (var x = loX; x <= hiX; x++) blocked[y * cols + x] = 0;
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/* 最小二叉堆，元素 {key, f} */
function Heap() { this.a = []; }
Heap.prototype.size = function () { return this.a.length; };
Heap.prototype.push = function (node) {
  var a = this.a;
  a.push(node);
  var i = a.length - 1;
  while (i > 0) {
    var parent = (i - 1) >> 1;
    if (a[parent].f <= a[i].f) break;
    var t = a[parent]; a[parent] = a[i]; a[i] = t;
    i = parent;
  }
};
Heap.prototype.pop = function () {
  var a = this.a;
  var top = a[0];
  var last = a.pop();
  if (a.length) {
    a[0] = last;
    var i = 0;
    for (;;) {
      var l = i * 2 + 1, r = l + 1, s = i;
      if (l < a.length && a[l].f < a[s].f) s = l;
      if (r < a.length && a[r].f < a[s].f) s = r;
      if (s === i) break;
      var t = a[s]; a[s] = a[i]; a[i] = t;
      i = s;
    }
  }
  return top;
};

function segKey(x1, y1, x2, y2) {
  if (x1 === x2) return 'V' + x1 + ':' + Math.min(y1, y2) + '-' + Math.max(y1, y2);
  return 'H' + y1 + ':' + Math.min(x1, x2) + '-' + Math.max(x1, x2);
}

/**
 * 单条边 A*。
 * occupancy: Map<segKey, 数量>，每多一条占用 => 额外代价，促使路径分散。
 */
function astar(blocked, cols, rows, sx, sy, tx, ty, occupancy) {
  if (blocked[sy * cols + sx] || blocked[ty * cols + tx]) return null;

  var start = sy * cols + sx;
  var target = ty * cols + tx;
  var size = cols * rows;
  var gScore = new Float64Array(size).fill(Infinity);
  var came = new Int32Array(size).fill(-1);
  var closed = new Uint8Array(size);
  var heap = new Heap();

  gScore[start] = 0;
  heap.push({ key: start, f: heuristic(sx, sy, tx, ty) });

  var expansions = 0;
  var MAX_EXPAND = Math.min(60000, size);

  while (heap.size() && expansions < MAX_EXPAND) {
    var cur = heap.pop();
    var key = cur.key;
    if (closed[key]) continue;
    closed[key] = 1;
    expansions++;
    if (key === target) return reconstruct(came, key, cols);

    var cx = key % cols;
    var cy = (key - cx) / cols;
    var prevDir = came[key] >= 0
      ? directionOf(came[key], key, cols)
      : -1;

    for (var d = 0; d < 4; d++) {
      var nx = cx + DIRS[d].dx;
      var ny = cy + DIRS[d].dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      var nk = ny * cols + nx;
      if (closed[nk] || blocked[nk]) continue;

      var stepCost = 10;
      if (prevDir >= 0 && prevDir !== d) stepCost += 6; // 转弯惩罚
      // 通道宽 = 一个网格；占用同段或相邻平行线都视为重叠
      var used = occupancy.get(segKey(cx, cy, nx, ny)) || 0;
      if (nx === cx) {
        used += occupancy.get(segKey(cx - 1, cy, nx - 1, ny)) || 0;
        used += occupancy.get(segKey(cx + 1, cy, nx + 1, ny)) || 0;
      } else {
        used += occupancy.get(segKey(cx, cy - 1, nx, ny - 1)) || 0;
        used += occupancy.get(segKey(cx, cy + 1, nx, ny + 1)) || 0;
      }
      stepCost += used * 30; // 共享/相邻通道惩罚，防重叠

      var tentative = gScore[key] + stepCost;
      if (tentative < gScore[nk]) {
        gScore[nk] = tentative;
        came[nk] = key;
        heap.push({
          key: nk,
          f: tentative + heuristic(nx, ny, tx, ty)
        });
      }
    }
  }
  return null;
}

function heuristic(x1, y1, x2, y2) {
  // 略低于纯步长代价，保证 A* 可接受性
  return (Math.abs(x1 - x2) + Math.abs(y1 - y2)) * 9;
}

function directionOf(aKey, bKey, cols) {
  var ax = aKey % cols, ay = (aKey - ax) / cols;
  var bx = bKey % cols, by = (bKey - bx) / cols;
  if (bx > ax) return 0;
  if (bx < ax) return 1;
  if (by > ay) return 2;
  return 3;
}

function reconstruct(came, key, cols) {
  var path = [];
  for (;;) {
    var x = key % cols;
    var y = (key - x) / cols;
    path.push({ gx: x, gy: y });
    if (came[key] < 0) break;
    key = came[key];
  }
  path.reverse();
  return path;
}

function countPortUsage(edges) {
  var usage = new Map();
  var sorted = edges.slice().sort(function (a, b) {
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  for (var i = 0; i < sorted.length; i++) {
    var e = sorted[i];
    pushUsage(usage, e.source + '|' + e.fromPort, e.id);
    pushUsage(usage, e.target + '|' + e.toPort, e.id);
  }
  return { map: usage, order: sorted };
}

function pushUsage(map, key, edgeId) {
  var arr = map.get(key);
  if (!arr) { arr = []; map.set(key, arr); }
  arr.push(edgeId);
}

function routeAll(data) {
  var t0 = Date.now();
  var nodes = data.nodes;
  var g = data.grid;
  var channel = data.channel;
  var nodeMap = {};
  nodes.forEach(function (n) { nodeMap[n.id] = n; });

  var marginCells = 24;
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  nodes.forEach(function (n) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  });
  if (data.view) {
    minX = Math.min(minX, 0);
    minY = Math.min(minY, 0);
    maxX = Math.max(maxX, data.view.w);
    maxY = Math.max(maxY, data.view.h);
  }
  minX = (Math.floor(minX / g) - marginCells) * g;
  minY = (Math.floor(minY / g) - marginCells) * g;
  maxX = (Math.ceil(maxX / g) + marginCells) * g;
  maxY = (Math.ceil(maxY / g) + marginCells) * g;
  var cols = Math.round((maxX - minX) / g) + 1;
  var rows = Math.round((maxY - minY) / g) + 1;
  if (cols * rows > 4000000) throw new Error('路由网格过大（节点可能离画布太远）');

  var used = countPortUsage(data.edges);
  var occupancy = new Map();
  var paths = {};
  var only = data.onlyIds ? new Set(data.onlyIds) : null;

  used.order.forEach(function (edge) {
    var src = nodeMap[edge.source];
    var dst = nodeMap[edge.target];
    if (!src || !dst) return;

    var sArr = used.map.get(edge.source + '|' + edge.fromPort) || [edge.id];
    var tArr = used.map.get(edge.target + '|' + edge.toPort) || [edge.id];
    var se = portEntry(src, edge.fromPort, channel, g, sArr.indexOf(edge.id), sArr.length);
    var ee = portEntry(dst, edge.toPort, channel, g, tArr.indexOf(edge.id), tArr.length);
    var sx = se.gx - Math.round(minX / g);
    var sy = se.gy - Math.round(minY / g);
    var tx = ee.gx - Math.round(minX / g);
    var ty = ee.gy - Math.round(minY / g);

    var pads = [channel + 2, g, 0];
    var gridPath = null;
    for (var a = 0; a < pads.length && !gridPath; a++) {
      var blocked = buildBlocked(nodes, se, ee, pads[a], g, minX, minY, cols, rows);
      gridPath = astar(blocked, cols, rows, sx, sy, tx, ty, occupancy);
    }
    if (!gridPath) {
      // 兜底：直线连接（极少出现，通常表示节点被完全包围）
      gridPath = [
        { gx: sx, gy: sy },
        { gx: tx, gy: ty }
      ];
    }

    for (var k = 0; k + 1 < gridPath.length; k++) {
      var p1 = gridPath[k], p2 = gridPath[k + 1];
      var key = segKey(p1.gx, p1.gy, p2.gx, p2.gy);
      occupancy.set(key, (occupancy.get(key) || 0) + 1);
    }
    // 端口桩段同样记账，防止多条线在接入端口前重合
    var portGx = Math.round(se.port.x / g);
    var portGy = Math.round(se.port.y / g);
    var stub = segKey(portGx, portGy, sx, sy);
    occupancy.set(stub, (occupancy.get(stub) || 0) + 1);
    var eportGx = Math.round(ee.port.x / g);
    var eportGy = Math.round(ee.port.y / g);
    var estub = segKey(eportGx, eportGy, tx, ty);
    occupancy.set(estub, (occupancy.get(estub) || 0) + 1);

    if (!only || only.has(edge.id)) {
      paths[edge.id] = toWorldPath(gridPath, se, ee, minX, minY, g);
    }
  });

  var overlaps = countOverlaps(occupancy);

  return {
    paths: paths,
    overlaps: overlaps,
    elapsed: Date.now() - t0
  };
}

function toWorldPath(gridPath, se, ee, minX, minY, g) {
  var ox = Math.round(minX / g) * g;
  var oy = Math.round(minY / g) * g;
  var first = gridPath[0];
  var last = gridPath[gridPath.length - 1];
  var sx = ox + first.gx * g, sy = oy + first.gy * g;
  var tx = ox + last.gx * g, ty = oy + last.gy * g;

  var pts = [{ x: se.port.x, y: se.port.y }];

  // 起点：仅在端口与首步共轴时直连，否则插入中间点，杜绝斜线段
  var sp = se.port;
  if (sp.x === sx || sp.y === sy) {
    pts.push({ x: sx, y: sy });
  } else {
    if (se.vx !== 0) pts.push({ x: sx, y: sp.y });
    else pts.push({ x: sp.x, y: sy });
    pts.push({ x: sx, y: sy });
  }

  for (var i = 1; i < gridPath.length - 1; i++) {
    pts.push({ x: ox + gridPath[i].gx * g, y: oy + gridPath[i].gy * g });
  }

  // 终点：同样按轴向补中间点
  var ep = ee.port;
  if (gridPath.length > 1) pts.push({ x: tx, y: ty });
  if (!(ep.x === tx && ep.y === ty)) {
    if (ep.x === tx || ep.y === ty) {
      pts.push({ x: ep.x, y: ep.y });
    } else {
      if (ee.vx !== 0) pts.push({ x: ep.x, y: ty });
      else pts.push({ x: tx, y: ep.y });
      pts.push({ x: ep.x, y: ep.y });
    }
  }

  return simplify(pts);
}

function simplify(pts) {
  var out = [];
  for (var i = 0; i < pts.length; i++) {
    var p = pts[i];
    var prev = out[out.length - 1];
    if (prev && Math.abs(prev.x - p.x) < 0.01 && Math.abs(prev.y - p.y) < 0.01) continue;
    if (out.length >= 2) {
      var a = out[out.length - 2], b = out[out.length - 1];
      if (
        (a.x === b.x && b.x === p.x) ||
        (a.y === b.y && b.y === p.y)
      ) {
        out[out.length - 1] = p;
        continue;
      }
    }
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

/* 统计重叠：同段多线 + 相邻平行线（间距 1 个网格即视为通道重叠）。 */
function countOverlaps(occupancy) {
  var overlaps = 0;
  var seen = new Set();
  occupancy.forEach(function (count, key) {
    if (count > 1) overlaps += count - 1;
    var m = /^([VH])(-?\d+):(-?\d+)-(-?\d+)$/.exec(key);
    if (!m) return;
    var axis = m[1];
    var a = Number(m[2]);
    var b = Number(m[3]);
    var c = Number(m[4]);
    [ -1, 1 ].forEach(function (delta) {
      var neighbor = axis + (a + delta) + ':' + b + '-' + c;
      var nCount = occupancy.get(neighbor);
      if (nCount) {
        var pairKey = key + '|' + neighbor;
        if (!seen.has(pairKey)) {
          seen.add(pairKey);
          seen.add(neighbor + '|' + key);
          overlaps += count * nCount;
        }
      }
    });
  });
  return overlaps;
}

self.onmessage = function (ev) {
  var data = ev.data || {};
  if (data.type !== 'route') return;
  try {
    var result = routeAll(data);
    self.postMessage({
      type: 'routes',
      id: data.id,
      paths: result.paths,
      overlaps: result.overlaps,
      elapsed: result.elapsed
    });
  } catch (err) {
    self.postMessage({
      type: 'error',
      id: data.id,
      message: (err && err.message) || String(err)
    });
  }
};
