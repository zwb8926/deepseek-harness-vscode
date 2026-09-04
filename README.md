# DSH for VS Code

**项目地址：https://github.com/zwb8926/deepseek-harness-vscode**

在 VS Code 中使用 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)。

本扩展**自行启动并管理 `dsh web` 服务**，并把 GUI **拆成两块**嵌入 VS Code

本次更新：

- **内嵌 dsh 升级到 `@deepseek-ai/dsh@0.1.2-alpha.2`**，扩展版本号同步为 2026.8.310（依赖树与前端拆分补丁随包重建）
- **适配 dsh 0.1.2+ 浏览器会话鉴权**：新版 dsh 的 GUI 改为鉴权，扩展管理器的健康检查、面板探测与全部 API 调用均已跟随该流程
- **内置本地 GUI 代理（新增）**：**新版 dsh 的完整 GUI（拆分面板、会话/工作区列表、实时流）仍可完整嵌入 VS Code**
- **RPC 协议自适应**：dsh 0.1.2+ 的 API 换为 typert 线协议（`namespace/method` 端点 + `{args:…}` 载荷），扩展自动识别并对齐；旧版 rc.2 服务仍按原协议通信，向后兼容
- **工作区与归档正确**：新版 dsh 移除了 `workspace.list`（状态改走 `workspace/follow` 流），扩展改为订阅该流取得**真实工作区列表与真实归档集合**——左侧栏不再出现按目录臆造的工作区，已归档会话正确隐藏
- **会话标题稳定显示**：部分历史会话在列表时缺少投影（标题显示「未命名」，需点开才会出现），扩展现在缓存标题并对缺失投影的会话自动通过 `session/follow` 快照回填
- 启动/接管/停止/重启、主题联动、状态栏与「Open in Browser」等行为保持不变
