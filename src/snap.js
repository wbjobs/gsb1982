// 网格吸附 + 对齐线：拖动节点时先网格取整，再与其他节点的边/中线对齐。

export function snapMoving(moving, others, {
  grid = 20,
  threshold = 6,
  useGrid = true,
  useAlign = true,
} = {}) {
  let { x, y } = moving;
  const { w, h } = moving;
  if (useGrid) {
    x = Math.round(x / grid) * grid;
    y = Math.round(y / grid) * grid;
  }
  const guides = [];
  if (useAlign && others.length) {
    const snapX = bestSnap([x, x + w / 2, x + w], others.map((o) => [o.x, o.x + o.w / 2, o.x + o.w]), threshold);
    if (snapX) {
      x += snapX.delta;
      guides.push({ axis: 'v', pos: snapX.pos });
    }
    const snapY = bestSnap([y, y + h / 2, y + h], others.map((o) => [o.y, o.y + o.h / 2, o.y + o.h]), threshold);
    if (snapY) {
      y += snapY.delta;
      guides.push({ axis: 'h', pos: snapY.pos });
    }
  }
  return { x, y, guides };
}

function bestSnap(mine, theirsList, threshold) {
  let best = null;
  for (const theirs of theirsList) {
    for (const m of mine) {
      for (const t of theirs) {
        const delta = t - m;
        if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) {
          best = { delta, pos: t };
        }
      }
    }
  }
  return best;
}
