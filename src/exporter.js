// 导出：SVG / PNG / JSON，以及 JSON 导入（带校验）。

const EXPORT_PAD = 24;

export function contentBBox(state, routes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x, y) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  };
  for (const n of state.nodes) { grow(n.x, n.y); grow(n.x + n.w, n.y + n.h); }
  for (const r of routes.values()) for (const p of r.points) grow(p.x, p.y);
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 800; maxY = 600; }
  return {
    x: minX - EXPORT_PAD, y: minY - EXPORT_PAD,
    w: maxX - minX + EXPORT_PAD * 2, h: maxY - minY + EXPORT_PAD * 2,
  };
}

function buildExportSVG(svgEl, state, routes) {
  const box = contentBBox(state, routes);
  const clone = svgEl.cloneNode(true);
  clone.querySelector('#overlay-layer')?.remove();
  clone.querySelector('#grid-rect')?.remove();
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(Math.ceil(box.w)));
  clone.setAttribute('height', String(Math.ceil(box.h)));
  clone.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
  clone.removeAttribute('style');
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('x', String(box.x)); bg.setAttribute('y', String(box.y));
  bg.setAttribute('width', String(box.w)); bg.setAttribute('height', String(box.h));
  bg.setAttribute('fill', '#ffffff');
  clone.insertBefore(bg, clone.firstChild);
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
  return { xml, box };
}

export function download(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function exportSVG(svgEl, state, routes, filename = 'diagram.svg') {
  const { xml } = buildExportSVG(svgEl, state, routes);
  download(filename, new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
}

export async function exportPNG(svgEl, state, routes, filename = 'diagram.png', scale = 2) {
  const { xml, box } = buildExportSVG(svgEl, state, routes);
  const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('SVG 渲染为图片失败'));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(box.w * scale));
    canvas.height = Math.max(1, Math.ceil(box.h * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 Canvas 上下文');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 编码失败'))), 'image/png'));
    download(filename, blob);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function exportJSON(state, routes, filename = 'diagram.json') {
  const data = {
    version: 1,
    nodes: state.nodes,
    edges: state.edges,
  };
  download(filename, new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
}

export async function importJSON(file) {
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('文件不是合法的 JSON');
  }
  if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
    throw new Error('JSON 结构不正确：需要 nodes 和 edges 数组');
  }
  const ids = new Set();
  const nodes = data.nodes.map((n, i) => {
    if (!n || typeof n.id !== 'string' || !isFinite(n.x) || !isFinite(n.y) || !isFinite(n.w) || !isFinite(n.h)) {
      throw new Error(`第 ${i + 1} 个节点字段缺失或非法`);
    }
    if (ids.has(n.id)) throw new Error(`节点 id 重复：${n.id}`);
    ids.add(n.id);
    return {
      id: n.id, x: +n.x, y: +n.y, w: +n.w, h: +n.h,
      label: typeof n.label === 'string' ? n.label : n.id,
      color: typeof n.color === 'string' ? n.color : '#4f8ef7',
    };
  });
  const edges = [];
  const skipped = [];
  for (const e of data.edges) {
    if (!e || typeof e.id !== 'string' || !ids.has(e.from) || !ids.has(e.to) || e.from === e.to) {
      skipped.push(e && e.id ? e.id : '(未知)');
      continue;
    }
    edges.push({ id: e.id, from: e.from, to: e.to });
  }
  return { nodes, edges, skipped };
}
