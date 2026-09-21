/* 导出：SVG / PNG / JSON。直接由数据模型序列化，避免克隆运行时 DOM 带来的偏差。 */
(function (global) {
  'use strict';

  function escapeXml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function graphBBox(state, pad) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    state.nodes.forEach(function (n) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.w);
      maxY = Math.max(maxY, n.y + n.h);
    });
    Object.keys(state.paths || {}).forEach(function (id) {
      state.paths[id].forEach(function (p) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      });
    });
    if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 800; maxY = 600; }
    return {
      x: Math.floor(minX - pad),
      y: Math.floor(minY - pad),
      w: Math.ceil(maxX - minX + pad * 2),
      h: Math.ceil(maxY - minY + pad * 2)
    };
  }

  function buildSvg(state, options) {
    var opts = options || {};
    var grid = opts.grid || 0;
    var box = graphBBox(state, 24);
    var parts = [];
    parts.push(
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + box.w + '" height="' + box.h +
        '" viewBox="' + box.x + ' ' + box.y + ' ' + box.w + ' ' + box.h + '">'
    );
    parts.push(
      '<defs>',
      '<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" ' +
        'markerHeight="9" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#5b6b7b"/></marker>',
      '</defs>'
    );
    parts.push('<rect x="' + box.x + '" y="' + box.y + '" width="' + box.w +
      '" height="' + box.h + '" fill="#fafbfc"/>');

    if (grid > 0 && opts.showGrid) {
      var d = [];
      for (var gx = Math.ceil(box.x / grid) * grid; gx <= box.x + box.w; gx += grid) {
        d.push('M' + gx + ' ' + box.y + 'V' + (box.y + box.h));
      }
      for (var gy = Math.ceil(box.y / grid) * grid; gy <= box.y + box.h; gy += grid) {
        d.push('M' + box.x + ' ' + gy + 'H' + (box.x + box.w));
      }
      parts.push('<path d="' + d.join('') + '" stroke="#e3e8ed" stroke-width="1" fill="none"/>');
    }

    parts.push('<g fill="none" stroke="#5b6b7b" stroke-width="1.8" stroke-linejoin="miter">');
    state.edges.forEach(function (e) {
      var pts = (state.paths || {})[e.id];
      if (!pts || pts.length < 2) return;
      var d2 = 'M' + pts[0].x + ' ' + pts[0].y;
      for (var i = 1; i < pts.length; i++) {
        d2 += 'L' + pts[i].x + ' ' + pts[i].y;
      }
      parts.push('<path d="' + d2 + '" marker-end="url(#arrow)"/>');
    });
    parts.push('</g>');

    state.nodes.forEach(function (n) {
      parts.push(
        '<g>',
        '<rect x="' + n.x + '" y="' + n.y + '" width="' + n.w + '" height="' + n.h +
          '" rx="6" fill="#ffffff" stroke="#94a3b2" stroke-width="1.5"/>',
        '<text x="' + (n.x + n.w / 2) + '" y="' + (n.y + n.h / 2) +
          '" text-anchor="middle" dominant-baseline="central" ' +
          'font-family="sans-serif" font-size="12.5" fill="#243447">' +
          escapeXml(n.label || '') + '</text>',
        '</g>'
      );
    });

    parts.push('</svg>');
    return parts.join('\n');
  }

  function download(filename, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function stamp() {
    var d = new Date();
    function p(v) { return String(v).padStart(2, '0'); }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function exportSvg(state, options) {
    var svg = buildSvg(state, options);
    download('diagram-' + stamp() + '.svg',
      new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  }

  function exportPng(state, options) {
    var scale = (options && options.scale) || 2;
    var svg = buildSvg(state, options);
    var box = graphBBox(state, 24);
    var blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        try {
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(box.w * scale));
          canvas.height = Math.max(1, Math.round(box.h * scale));
          var ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('无法获取 Canvas 2D 上下文');
          ctx.fillStyle = '#fafbfc';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(function (pngBlob) {
            URL.revokeObjectURL(url);
            if (!pngBlob) { reject(new Error('PNG 编码失败')); return; }
            download('diagram-' + stamp() + '.png', pngBlob);
            resolve();
          }, 'image/png');
        } catch (err) {
          URL.revokeObjectURL(url);
          reject(err);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('SVG 无法光栅化（浏览器可能禁止了 SVG 图像加载）'));
      };
      img.src = url;
    });
  }

  function toJSON(state) {
    return JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      nodes: state.nodes.map(function (n) {
        return { id: n.id, x: n.x, y: n.y, w: n.w, h: n.h, label: n.label };
      }),
      edges: state.edges.map(function (e) {
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          fromPort: e.fromPort,
          toPort: e.toPort
        };
      })
    }, null, 2);
  }

  function exportJson(state) {
    download('diagram-' + stamp() + '.json',
      new Blob([toJSON(state)], { type: 'application/json;charset=utf-8' }));
  }

  var SIDES = { top: 1, right: 1, bottom: 1, left: 1 };

  function validateGraph(data) {
    if (!data || typeof data !== 'object') throw new Error('文件内容不是有效的 JSON 对象');
    if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
      throw new Error('缺少 nodes 或 edges 数组');
    }
    if (data.nodes.length > 2000) throw new Error('节点数超过 2000 的上限');
    if (data.edges.length > 5000) throw new Error('连线数超过 5000 的上限');

    var ids = new Set();
    var nodes = data.nodes.map(function (raw, i) {
      if (!raw || typeof raw !== 'object') throw new Error('第 ' + (i + 1) + ' 个节点格式错误');
      var n = {
        id: raw.id != null ? String(raw.id) : 'n' + (i + 1),
        x: toNum(raw.x, '节点 ' + i + ' 的 x'),
        y: toNum(raw.y, '节点 ' + i + ' 的 y'),
        w: toNum(raw.w, '节点 ' + i + ' 的 w'),
        h: toNum(raw.h, '节点 ' + i + ' 的 h'),
        label: raw.label == null ? '节点' : String(raw.label)
      };
      if (n.w <= 0 || n.h <= 0) throw new Error('节点 ' + n.id + ' 宽高必须为正数');
      if (ids.has(n.id)) throw new Error('节点 id 重复：' + n.id);
      ids.add(n.id);
      return n;
    });

    var eids = new Set();
    var edges = data.edges.map(function (raw, i) {
      if (!raw || typeof raw !== 'object') throw new Error('第 ' + (i + 1) + ' 条连线格式错误');
      var e = {
        id: raw.id != null ? String(raw.id) : 'e' + (i + 1),
        source: String(raw.source),
        target: String(raw.target),
        fromPort: raw.fromPort || 'right',
        toPort: raw.toPort || 'left'
      };
      if (!ids.has(e.source) || !ids.has(e.target)) {
        throw new Error('连线 ' + e.id + ' 引用了不存在的节点');
      }
      if (!SIDES[e.fromPort] || !SIDES[e.toPort]) {
        throw new Error('连线 ' + e.id + ' 的端口必须是 top/right/bottom/left');
      }
      if (eids.has(e.id)) throw new Error('连线 id 重复：' + e.id);
      eids.add(e.id);
      return e;
    });

    return { nodes: nodes, edges: edges };
  }

  function toNum(v, label) {
    var n = Number(v);
    if (!isFinite(n)) throw new Error(label + ' 不是有效数字');
    return n;
  }

  global.Exporter = {
    buildSvg: buildSvg,
    exportSvg: exportSvg,
    exportPng: exportPng,
    exportJson: exportJson,
    validateGraph: validateGraph,
    toJSON: toJSON
  };
})(window);
