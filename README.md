# 流程图编辑器

基于 **SVG + Web Worker** 的轻量流程图编辑器，支持网格吸附、对齐线、正交路由与多格式导出。

## 运行

```bash
python3 -m http.server 8080   # 或 npm run serve
# 打开 http://localhost:8080
```

> 需要通过 HTTP 访问（ES Module 与 Web Worker 在 file:// 下受限）。
> 若 Worker 不可用，应用会自动降级为主线程路由并给出提示。

## 功能

- **网格吸附**：拖动节点自动对齐 20px 网格，可用工具栏开关。
- **对齐线**：拖动时与其他节点的边 / 中线在 6px 阈值内自动吸附，并显示红色对齐参考线。
- **正交路由**：Web Worker 中执行网格 A*，绕开节点障碍、端口车道分配、逐线占用标记，保证连线互不重叠；找不到路径时降级为简单折线（红色虚线）并提示。
- **导出**：SVG（自包含样式，裁剪到内容包围盒）、PNG（2x 白底）、JSON（可再导入，带结构校验）。
- **异常提示**：全局错误、路由失败、导入校验失败等均通过右上角 Toast 提示。

## 操作

- 拖拽节点移动；点击选中节点 / 连线，`Delete` 删除。
- 点击「连线」后依次点击两个节点创建连线，`Esc` 退出连线模式。
- 滚轮缩放，拖拽空白处平移。

## 架构

```
index.html            页面骨架（SVG 内联样式，导出自包含）
styles.css            页面样式
src/app.js            交互、渲染调度（rAF 批量渲染、拖动节流路由）
src/router-core.js    正交路由核心（纯函数，Worker / 主线程 / 测试共用）
src/router-worker.js  路由 Web Worker
src/router-client.js  Worker 客户端，失败自动降级主线程
src/snap.js           网格吸附 + 对齐线计算
src/exporter.js       SVG / PNG / JSON 导出与 JSON 导入校验
src/toast.js          提示条与全局异常捕获
tests/                node:test 单元测试
```

## 测试

```bash
npm test
```

覆盖验收标准：路由正交性、连线互不重叠、障碍避让、封死场景降级告警、
30 节点 / 50 连线性能（< 3s，实测约 0.3s）、网格吸附与对齐线准确性。

## 性能设计

- 路由计算全部在 Web Worker 中执行，不阻塞 UI。
- 拖动节点时使用轻量 L 形预览线，路由请求按 150ms 节流、松手后立即全量重算。
- 渲染通过 `requestAnimationFrame` 合帧；过期路由结果直接丢弃。
