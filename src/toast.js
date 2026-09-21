// 轻量提示条：错误 / 警告 / 信息。全局异常统一在此上报。

export function toast(message, type = 'info', ms = 4000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const item = document.createElement('div');
  item.className = `toast toast-${type}`;
  item.textContent = message;
  container.appendChild(item);
  requestAnimationFrame(() => item.classList.add('show'));
  setTimeout(() => {
    item.classList.remove('show');
    setTimeout(() => item.remove(), 300);
  }, ms);
}

export function installGlobalHandlers() {
  window.addEventListener('error', (e) => {
    toast(`运行错误：${e.message || '未知错误'}`, 'error');
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason && e.reason.message ? e.reason.message : String(e.reason);
    toast(`异步错误：${reason}`, 'error');
  });
}
