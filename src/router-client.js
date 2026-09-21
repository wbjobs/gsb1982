/* 路由客户端：调度 Web Worker，失败/超时时同步肘形兜底，保证交互不中断。 */
(function (global) {
  'use strict';

  var OUT = {
    right: [1, 0],
    left: [-1, 0],
    bottom: [0, 1],
    top: [0, -1]
  };

  function portAnchor(node, side, channel, index, total) {
    var offset = 0;
    if (total > 1) {
      var span = side === 'top' || side === 'bottom' ? node.w : node.h;
      var usable = Math.max(span - 12, channel);
      offset = (index - (total - 1) / 2) *
        Math.min(usable / Math.max(total - 1, 1), channel);
    }
    if (side === 'top') return { x: node.x + node.w / 2 + offset, y: node.y };
    if (side === 'bottom') return { x: node.x + node.w / 2 + offset, y: node.y + node.h };
    if (side === 'left') return { x: node.x, y: node.y + node.h / 2 + offset };
    return { x: node.x + node.w, y: node.y + node.h / 2 + offset };
  }

  function usage(edges) {
    var map = new Map();
    edges
      .slice()
      .sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; })
      .forEach(function (e) {
        add(map, e.source + '|' + e.fromPort, e.id);
        add(map, e.target + '|' + e.toPort, e.id);
      });
    return map;
  }

  function add(map, key, id) {
    var arr = map.get(key);
    if (!arr) { arr = []; map.set(key, arr); }
    arr.push(id);
  }

  function selfLoop(node, edge) {
    var r = 18;
    if (edge.fromPort === 'top' || edge.fromPort === 'bottom') {
      var px = node.x + node.w / 2;
      var py = edge.fromPort === 'top' ? node.y : node.y + node.h;
      var dir = edge.fromPort === 'top' ? -1 : 1;
      return [
        { x: px, y: py },
        { x: px, y: py + dir * r },
        { x: px + r * 2, y: py + dir * r },
        { x: px + r * 2, y: py }
      ];
    }
    var py2 = node.y + node.h / 2;
    var px2 = edge.fromPort === 'left' ? node.x : node.x + node.w;
    var dir2 = edge.fromPort === 'left' ? -1 : 1;
    return [
      { x: px2, y: py2 },
      { x: px2 + dir2 * r, y: py2 },
      { x: px2 + dir2 * r, y: py2 - r * 2 },
      { x: px2, y: py2 - r * 2 }
    ];
  }

  function RouterClient(timeoutMs) {
    this.timeoutMs = timeoutMs || 4000;
    this.pending = new Map();
    this.seq = 0;
    this.broken = false;
    this.worker = null;
    try {
      this.worker = new Worker('src/router-worker.js');
      this.worker.onmessage = this.onMessage.bind(this);
      this.worker.onerror = this.onError.bind(this);
    } catch (err) {
      this.broken = true;
      this.worker = null;
    }
  }

  RouterClient.prototype.onMessage = function (ev) {
    var msg = ev.data || {};
    if (msg.type === 'routes') {
      var job = this.pending.get(msg.id);
      if (!job) return;
      clearTimeout(job.timer);
      this.pending.delete(msg.id);
      job.resolve({ paths: msg.paths, overlaps: msg.overlaps, elapsed: msg.elapsed });
    } else if (msg.type === 'error') {
      var job2 = this.pending.get(msg.id);
      if (!job2) return;
      clearTimeout(job2.timer);
      this.pending.delete(msg.id);
      job2.reject(new Error(msg.message || '路由 Worker 计算失败'));
    }
  };

  RouterClient.prototype.onError = function (ev) {
    this.broken = true;
    var message = ev && ev.message ? ev.message : '路由 Worker 不可用';
    this.pending.forEach(function (job) {
      clearTimeout(job.timer);
      job.reject(new Error(message));
    });
    this.pending.clear();
  };

  /** 发起一次全量/增量路由，返回 Promise。 */
  RouterClient.prototype.route = function (payload) {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (self.broken || !self.worker) {
        reject(new Error('路由 Worker 不可用，使用本地兜底'));
        return;
      }
      var id = ++self.seq;
      var timer = setTimeout(function () {
        self.pending.delete(id);
        reject(new Error('路由计算超时，使用本地兜底'));
      }, self.timeoutMs);
      self.pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      self.worker.postMessage(Object.assign({ type: 'route', id: id }, payload));
    });
  };

  /** 同步兜底：简单肘形线，保证拖拽期间连线实时可见。 */
  RouterClient.prototype.quickRoutes = function (payload) {
    var nodeMap = {};
    payload.nodes.forEach(function (n) { nodeMap[n.id] = n; });
    var portUsage = usage(payload.edges);
    var paths = {};
    var only = payload.onlyIds ? new Set(payload.onlyIds) : null;
    payload.edges.forEach(function (e) {
      if (only && !only.has(e.id)) return;
      var src = nodeMap[e.source];
      var dst = nodeMap[e.target];
      if (!src || !dst) return;
      var sArr = portUsage.get(e.source + '|' + e.fromPort) || [e.id];
      var tArr = portUsage.get(e.target + '|' + e.toPort) || [e.id];
      var p0 = portAnchor(src, e.fromPort, payload.channel, sArr.indexOf(e.id), sArr.length);
      var p1 = portAnchor(dst, e.toPort, payload.channel, tArr.indexOf(e.id), tArr.length);
      paths[e.id] = quickElbowAnchors(p0, p1, e, src, dst, payload.channel);
    });
    return { paths: paths, overlaps: -1, elapsed: 0, fallback: true };
  };

  function quickElbowAnchors(p0, p1, edge, src, dst, channel) {
    if (src.id === dst.id) return selfLoop(src, edge);
    var sH = edge.fromPort === 'left' || edge.fromPort === 'right';
    var tH = edge.toPort === 'left' || edge.toPort === 'right';
    var v0 = OUT[edge.fromPort];
    if (sH && tH) {
      var mx = (p0.x + p1.x) / 2;
      return [p0, { x: mx, y: p0.y }, { x: mx, y: p1.y }, p1];
    }
    if (!sH && !tH) {
      var my = (p0.y + p1.y) / 2;
      return [p0, { x: p0.x, y: my }, { x: p1.x, y: my }, p1];
    }
    if (sH && !tH) {
      var mx2 = p0.x + v0[0] * Math.max(channel, 20);
      return [p0, { x: mx2, y: p0.y }, { x: mx2, y: p1.y }, p1];
    }
    var my2 = p0.y + v0[1] * Math.max(channel, 20);
    return [p0, { x: p0.x, y: my2 }, { x: p1.x, y: my2 }, p1];
  }

  global.RouterClient = RouterClient;
  global.PortAnchor = portAnchor;
})(window);
