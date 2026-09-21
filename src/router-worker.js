// 路由 Web Worker：在后台线程计算正交路由，避免阻塞 UI。
import { routeAll } from './router-core.js';

self.onmessage = (ev) => {
  const { id, nodes, edges, options } = ev.data || {};
  try {
    const { routes, warnings } = routeAll(nodes, edges, options);
    self.postMessage({ id, ok: true, routes: [...routes.entries()], warnings });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
