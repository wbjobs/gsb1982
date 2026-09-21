/* 几何工具：网格吸附 + 对齐线计算（无依赖，供主线程使用） */
(function (global) {
  'use strict';

  function snap(value, grid) {
    if (!grid || grid <= 0) return value;
    return Math.round(value / grid) * grid;
  }

  function snapPoint(point, grid) {
    return { x: snap(point.x, grid), y: snap(point.y, grid) };
  }

  function rectOf(node) {
    return {
      id: node.id,
      x: node.x,
      y: node.y,
      w: node.w,
      h: node.h,
      cx: node.x + node.w / 2,
      cy: node.y + node.h / 2,
      right: node.x + node.w,
      bottom: node.y + node.h
    };
  }

  /**
   * 计算移动中矩形与其它矩形的对齐参考线。
   * 可对齐特征：左/中/右（垂直参考线），上/中/下（水平参考线）。
   * 返回 { vertical: [{x, min, max}], horizontal: [{y, min, max}] }
   */
  function computeGuides(moving, others, threshold) {
    const m = typeof moving.x === 'number' ? rectOf(moving) : moving;
    const vertical = [];
    const horizontal = [];

    const vFeatures = [
      { value: m.x, key: 'x' },
      { value: m.cx, key: 'cx' },
      { value: m.right, key: 'right' }
    ];
    const hFeatures = [
      { value: m.y, key: 'y' },
      { value: m.cy, key: 'cy' },
      { value: m.bottom, key: 'bottom' }
    ];

    for (const rawOther of others) {
      const o = rectOf(rawOther);
      for (const f of vFeatures) {
        for (const key of ['x', 'cx', 'right']) {
          const delta = f.value - o[key];
          if (Math.abs(delta) <= threshold) {
            vertical.push({
              x: o[key],
              delta,
              min: Math.min(m.y, o.y),
              max: Math.max(m.bottom, o.bottom)
            });
          }
        }
      }
      for (const f of hFeatures) {
        for (const key of ['y', 'cy', 'bottom']) {
          const delta = f.value - o[key];
          if (Math.abs(delta) <= threshold) {
            horizontal.push({
              y: o[key],
              delta,
              min: Math.min(m.x, o.x),
              max: Math.max(m.right, o.right)
            });
          }
        }
      }
    }

    // 同一坐标可能有多条匹配，仅保留修正量最小、跨度最大的一条
    const dedupe = (list, axis) => {
      const map = new Map();
      for (const g of list) {
        const k = g[axis];
        const prev = map.get(k);
        if (
          !prev ||
          Math.abs(g.delta) < Math.abs(prev.delta) ||
          (Math.abs(g.delta) === Math.abs(prev.delta) &&
            g.max - g.min > prev.max - prev.min)
        ) {
          map.set(k, g);
        }
      }
      return Array.from(map.values());
    };

    return {
      vertical: dedupe(vertical, 'x').map((g) => ({
        x: g.x,
        min: g.min,
        max: g.max
      })),
      horizontal: dedupe(horizontal, 'y').map((g) => ({
        y: g.y,
        min: g.min,
        max: g.max
      }))
    };
  }

  /**
   * 根据对齐线修正移动矩形的位置；同时返回命中的参考线以便绘制。
   * 返回 { x, y, hitV, hitH }
   */
  function applyGuides(pos, size, guides, threshold) {
    let { x, y } = pos;
    const { w, h } = size;
    const feats = {
      x: [
        { value: x, set: (d) => { x -= d; } },
        { value: x + w / 2, set: (d) => { x -= d; } },
        { value: x + w, set: (d) => { x -= d; } }
      ],
      y: [
        { value: y, set: (d) => { y -= d; } },
        { value: y + h / 2, set: (d) => { y -= d; } },
        { value: y + h, set: (d) => { y -= d; } }
      ]
    };

    let hitV = null;
    let hitH = null;

    for (const g of guides.vertical) {
      let best = null;
      for (const f of feats.x) {
        const d = f.value - g.x;
        if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d))) {
          best = { d, set: f.set };
        }
      }
      if (best && (!hitV || Math.abs(best.d) < Math.abs(hitV.d))) {
        hitV = { guide: g, d: best.d, set: best.set };
      }
    }
    for (const g of guides.horizontal) {
      let best = null;
      for (const f of feats.y) {
        const d = f.value - g.y;
        if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d))) {
          best = { d, set: f.set };
        }
      }
      if (best && (!hitH || Math.abs(best.d) < Math.abs(hitH.d))) {
        hitH = { guide: g, d: best.d, set: best.set };
      }
    }

    if (hitV) hitV.set(hitV.d);
    if (hitH) hitH.set(hitH.d);

    return {
      x,
      y,
      hitV: hitV ? hitV.guide : null,
      hitH: hitH ? hitH.guide : null
    };
  }

  function pointInRect(px, py, rect) {
    return (
      px >= rect.x &&
      px <= rect.x + rect.w &&
      py >= rect.y &&
      py <= rect.y + rect.h
    );
  }

  /** 矩形边按通道宽度向外膨胀（用于路由避让） */
  function inflateRect(rect, pad) {
    return {
      x: rect.x - pad,
      y: rect.y - pad,
      w: rect.w + pad * 2,
      h: rect.h + pad * 2
    };
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';

  global.Geo = {
    snap,
    snapPoint,
    rectOf,
    computeGuides,
    applyGuides,
    pointInRect,
    inflateRect,
    SVG_NS
  };
})(window);
