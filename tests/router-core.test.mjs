import test from 'node:test';
import assert from 'node:assert/strict';
import { routeAll } from '../src/router-core.js';

function gridNodes(cols, rows, startX = 0, startY = 0, gapX = 260, gapY = 200) {
  const nodes = [];
  let id = 1;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      nodes.push({ id: `n${id++}`, x: startX + c * gapX, y: startY + r * gapY, w: 140, h: 56 });
  return nodes;
}

function segments(points) {
  const segs = [];
  for (let i = 1; i < points.length; i++) segs.push([points[i - 1], points[i]]);
  return segs;
}

// 共线且投影区间有正长度重叠 => 线段重叠
function segsOverlap(s1, s2) {
  const [[a, b], [c, d]] = [s1, s2];
  const cross = (o, p, q) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  if (cross(a, b, c) !== 0 || cross(a, b, d) !== 0) return false;
  if (a.x === b.x) { // 垂直段
    const [lo1, hi1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
    const [lo2, hi2] = [Math.min(c.y, d.y), Math.max(c.y, d.y)];
    return Math.min(hi1, hi2) - Math.max(lo1, lo2) > 1e-9;
  }
  const [lo1, hi1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
  const [lo2, hi2] = [Math.min(c.x, d.x), Math.max(c.x, d.x)];
  return Math.min(hi1, hi2) - Math.max(lo1, lo2) > 1e-9;
}

function pointInRect(p, n, inset = 1) {
  return p.x > n.x + inset && p.x < n.x + n.w - inset && p.y > n.y + inset && p.y < n.y + n.h - inset;
}

test('路由结果为正交线段，端点位于节点边界', () => {
  const nodes = gridNodes(3, 2);
  const edges = [
    { id: 'e1', from: 'n1', to: 'n4' },
    { id: 'e2', from: 'n2', to: 'n5' },
    { id: 'e3', from: 'n1', to: 'n6' },
  ];
  const { routes, warnings } = routeAll(nodes, edges);
  assert.equal(warnings.length, 0, `不应有警告: ${warnings}`);
  assert.equal(routes.size, 3);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of edges) {
    const { points, degraded } = routes.get(e.id);
    assert.ok(!degraded);
    assert.ok(points.length >= 2);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      assert.ok(a.x === b.x || a.y === b.y, `线段必须水平或垂直: ${JSON.stringify([a, b])}`);
    }
    const first = points[0], last = points[points.length - 1];
    const na = byId.get(e.from), nb = byId.get(e.to);
    const onBoundary = (p, n) =>
      p.x >= n.x - 1e-9 && p.x <= n.x + n.w + 1e-9 && p.y >= n.y - 1e-9 && p.y <= n.y + n.h + 1e-9 &&
      (p.x === n.x || p.x === n.x + n.w || p.y === n.y || p.y === n.y + n.h);
    assert.ok(onBoundary(first, na), '起点应在源节点边界上');
    assert.ok(onBoundary(last, nb), '终点应在目标节点边界上');
  }
});

test('多条连线互不重叠，且不穿过节点内部', () => {
  const nodes = gridNodes(4, 3);
  const edges = [];
  let id = 1;
  // 制造密集交叉场景
  const pairs = [
    ['n1', 'n12'], ['n4', 'n9'], ['n1', 'n8'], ['n5', 'n12'],
    ['n2', 'n11'], ['n3', 'n10'], ['n1', 'n6'], ['n7', 'n12'],
    ['n2', 'n7'], ['n3', 'n8'], ['n4', 'n11'], ['n5', 'n10'],
  ];
  for (const [from, to] of pairs) edges.push({ id: `e${id++}`, from, to });
  const { routes, warnings } = routeAll(nodes, edges);
  assert.equal(warnings.length, 0, `不应有警告: ${warnings}`);
  assert.equal(routes.size, edges.length);

  const allSegs = edges.map((e) => segments(routes.get(e.id).points));
  for (let i = 0; i < allSegs.length; i++)
    for (let j = i + 1; j < allSegs.length; j++)
      for (const s1 of allSegs[i])
        for (const s2 of allSegs[j])
          assert.ok(!segsOverlap(s1, s2), `连线 ${edges[i].id} 与 ${edges[j].id} 存在重叠`);

  // 不穿过任何节点内部（沿线段每 2px 采样）
  for (const e of edges) {
    for (const [a, b] of segments(routes.get(e.id).points)) {
      const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      const steps = Math.max(1, Math.ceil(len / 2));
      for (let s = 0; s <= steps; s++) {
        const p = { x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps };
        for (const n of nodes) {
          assert.ok(!pointInRect(p, n), `连线 ${e.id} 穿过节点 ${n.id} 内部 (${p.x},${p.y})`);
        }
      }
    }
  }
});

test('非法连线产生警告并被跳过', () => {
  const nodes = gridNodes(2, 1);
  const edges = [
    { id: 'e1', from: 'n1', to: 'nX' },   // 端点缺失
    { id: 'e2', from: 'n1', to: 'n1' },   // 自环
    { id: 'e3', from: 'n1', to: 'n2' },   // 正常
  ];
  const { routes, warnings } = routeAll(nodes, edges);
  assert.equal(routes.size, 1);
  assert.ok(routes.has('e3'));
  assert.ok(warnings.length >= 2, '应产生至少两条警告');
});

test('完全被封死的目标节点降级为简单折线并告警', () => {
  const B = { id: 'B', x: 1000, y: 1000, w: 100, h: 60 };
  const nodes = [
    { id: 'A', x: 0, y: 0, w: 140, h: 56 },
    B,
    // 四面围墙（膨胀后无缝隙）
    { id: 'w1', x: 700, y: 900, w: 700, h: 60 },
    { id: 'w2', x: 700, y: 1100, w: 700, h: 60 },
    { id: 'w3', x: 800, y: 900, w: 160, h: 260 },
    { id: 'w4', x: 1140, y: 900, w: 160, h: 260 },
  ];
  const edges = [{ id: 'e1', from: 'A', to: 'B' }];
  const { routes, warnings } = routeAll(nodes, edges);
  const r = routes.get('e1');
  assert.ok(r, '应返回降级路径');
  assert.equal(r.degraded, true);
  assert.ok(warnings.some((w) => w.includes('e1')));
});

test('性能：30 节点 / 50 连线在可接受时间内完成', () => {
  const nodes = gridNodes(6, 5, 0, 0, 300, 240);
  const edges = [];
  let id = 1;
  for (let k = 0; k < 50; k++) {
    const a = (k * 7) % 30 + 1;
    const b = (k * 11 + 5) % 30 + 1;
    if (a !== b) edges.push({ id: `e${id++}`, from: `n${a}`, to: `n${b}` });
  }
  const t0 = performance.now();
  const { routes } = routeAll(nodes, edges);
  const ms = performance.now() - t0;
  assert.equal(routes.size, edges.length);
  assert.ok(ms < 3000, `路由耗时 ${ms.toFixed(0)}ms，超过 3000ms`);
  console.log(`    路由 ${edges.length} 条连线耗时 ${ms.toFixed(1)}ms`);
});
