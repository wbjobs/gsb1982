import test from 'node:test';
import assert from 'node:assert/strict';
import { snapMoving } from '../src/snap.js';

test('网格吸附：坐标取整到网格倍数', () => {
  const r = snapMoving({ x: 113, y: 87, w: 140, h: 56 }, [], { grid: 20, threshold: 6 });
  assert.equal(r.x, 120);
  assert.equal(r.y, 80);
  assert.equal(r.guides.length, 0);
});

test('对齐吸附：靠近其他节点边缘时吸附并给出对齐线', () => {
  const others = [{ x: 100, y: 100, w: 140, h: 56 }];
  // 拖动节点左边距其他节点左边 4px，应吸附对齐
  const r = snapMoving({ x: 104, y: 300, w: 140, h: 56 }, others, { grid: 1, threshold: 6 });
  assert.equal(r.x, 100);
  assert.ok(r.guides.some((g) => g.axis === 'v' && g.pos === 100));
});

test('中心线对齐', () => {
  const others = [{ x: 100, y: 100, w: 140, h: 56 }]; // 中心 x = 170
  const r = snapMoving({ x: 97, y: 300, w: 140, h: 56 }, others, { grid: 1, threshold: 6 });
  assert.equal(r.x, 100); // 97+70=167 -> 170，delta=3 在阈值内
  assert.ok(r.guides.some((g) => g.axis === 'v'));
});

test('中心线对齐（宽度不同，唯一命中中心）', () => {
  const others = [{ x: 100, y: 100, w: 140, h: 56 }]; // 中心 x = 170
  // 移动节点宽 100：x=117 时中心 167，距 170 为 3；左边距 100 为 17，右边距 240 为 23
  const r = snapMoving({ x: 117, y: 300, w: 100, h: 56 }, others, { grid: 1, threshold: 6 });
  assert.equal(r.x, 120);
  assert.ok(r.guides.some((g) => g.axis === 'v' && g.pos === 170));
});

test('超出阈值不吸附', () => {
  const others = [{ x: 100, y: 100, w: 140, h: 56 }];
  const r = snapMoving({ x: 120, y: 300, w: 140, h: 56 }, others, { grid: 1, threshold: 6 });
  assert.equal(r.x, 120);
  assert.equal(r.guides.length, 0);
});

test('可同时产生水平与垂直两条对齐线', () => {
  const others = [{ x: 100, y: 100, w: 140, h: 56 }];
  const r = snapMoving({ x: 103, y: 98, w: 140, h: 56 }, others, { grid: 1, threshold: 6 });
  assert.equal(r.x, 100);
  assert.equal(r.y, 100);
  assert.equal(r.guides.length, 2);
});
