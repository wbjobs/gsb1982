// 路由客户端：优先使用 Web Worker；Worker 不可用时自动降级到主线程。
import { routeAll } from './router-core.js';

export class RouterClient {
  constructor({ onResult, onWarning } = {}) {
    this.onResult = onResult || (() => {});
    this.onWarning = onWarning || (() => {});
    this.pending = null;
    this.busy = false;
    this.seq = 0;
    this.currentId = 0;
    this.worker = null;
    try {
      this.worker = new Worker(new URL('./router-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (ev) => this.handleMessage(ev.data);
      this.worker.onerror = () => this.fallback('路由 Worker 异常，已切换为主线程路由');
    } catch {
      this.fallback('当前环境不支持 Web Worker，已切换为主线程路由', true);
    }
  }

  fallback(message, silent = false) {
    if (this.worker) { try { this.worker.terminate(); } catch { /* ignore */ } }
    this.worker = null;
    this.busy = false;
    if (!silent) this.onWarning(message);
    this.flush();
  }

  request(nodes, edges, options) {
    this.pending = { nodes, edges, options };
    this.flush();
  }

  flush() {
    if (!this.pending || this.busy) return;
    const job = this.pending;
    this.pending = null;
    if (this.worker) {
      this.busy = true;
      this.currentId = ++this.seq;
      this.worker.postMessage({ id: this.currentId, ...job });
    } else {
      // 主线程降级：异步执行，避免阻塞当前交互帧
      setTimeout(() => {
        try {
          const { routes, warnings } = routeAll(job.nodes, job.edges, job.options);
          this.onResult({ routes, warnings });
        } catch (err) {
          this.onWarning(`路由计算失败：${(err && err.message) || err}`);
        }
        this.flush();
      }, 0);
    }
  }

  handleMessage(data) {
    this.busy = false;
    if (!data || data.id !== this.currentId) { this.flush(); return; } // 过期结果丢弃
    if (!data.ok) {
      this.onWarning(`路由计算失败：${data.error || '未知错误'}`);
    } else {
      this.onResult({ routes: new Map(data.routes), warnings: data.warnings || [] });
    }
    this.flush();
  }
}
