# DSH for VS Code

**项目地址：https://github.com/zwb8926/deepseek-harness-vscode**

在 VS Code 中使用 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)。

本扩展**自行启动并管理 `dsh web` 服务**，并把 GUI **拆成两块**嵌入 VS Code

本次更新（适配 `@deepseek-ai/dsh@0.1.2-rc.1`，版本 2026.9.4）：

- [@sinply](https://github.com/sinply)     PR [#18](https://github.com/zwb8926/deepseek-harness-vscode/pull/18)

- **内嵌 dsh 升级到 `@deepseek-ai/dsh@0.1.2-rc.1`**（依赖树与前端拆分补丁随包重建）
- **浏览器会话鉴权与本地 GUI 代理**：rc.1 与 alpha.2 相同，`GET /?token=…` 交换 SameSite=Strict Cookie；跨源 webview iframe 无法携带该 Cookie，扩展在本机随机端口起反向代理注入 Cookie 并转发 HTTP 与 WebSocket（`/api/remote.mux`），完整 GUI（拆分面板、会话/工作区列表、实时流）仍可嵌入 VS Code；代理启动失败才回退「在浏览器打开」
- **拆分面板适配 rc.1 前端**：rc.1 的 AppFrame 三栏结构与 0.1.2-alpha.2 相同（内联 `grid-template-columns` 网格、带 `data-side` 的拖拽手柄、CSS-module 类名按 `<hash>_<local>` 生成，`frame/sidebarCol/centerCol/detailsCol/handle/overlay` 等稳定后缀仍在，只是它们由**运行时插件 bundle 注入的 `<style data-plugin-css>`** 提供、不在 shell 静态资源里）。panel-inject 的 CSS 改用「后缀/子串 + `:has()` 定位 AppFrame」的选择器，`?dshPanel=sidebar|center` 在 rc.1 上生效；设置弹窗（rc.1 仍挂载在侧栏脚部 `sidebar.settings`）与 `dsh.sessions.current` 会话恢复逻辑与 rc.1 保持兼容
- **前端补丁发现范围扩大**：`dsh-web-frontend` 在 npm 全局安装里是 `@deepseek-ai/dsh` 的**嵌套依赖**（`<root>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html`），现在运行时补丁既扫描顶层也扫描嵌套布局，并且对自己 spawn 的 CLI 用 `require.resolve` 精确定位其前端——接管外部服务（终端里 `npx dsh web`、全局 `dsh`）时也能就地打上拆分补丁（dsh 的前端静态服务每次请求都重读 `index.html`，无需重启）。**只有补丁可达的前端才启用分栏**；否则自动降级为「整页 GUI 嵌入 + 浏览器打开」并给出明确提示（见下）
- **RPC 协议自适应**：0.1.2+ 的 API 为 typert 线协议（`namespace/method` 端点 + `{args:…}` 载荷），扩展自动识别并对齐；旧版服务仍按原协议通信，向后兼容
- **工作区与归档正确**：rc.1 **没有一元 `workspace.list`**（实测 `POST /api/workspace/list` 返回 404）——工作区列表与归档集合的真实来源仍是 `workspace/follow` 流基线；`workspace/create/rename/delete/archiveSession/insertSessionBefore` 等变更操作则是一元 `workspace/*` Remote。扩展先探测一次一元端点（为将来可能的恢复预留），随后订阅 follow 基线并做 5 秒缓存，避免 4 秒一次的侧栏刷新反复开关 mux 流——左侧栏不再出现按目录臆造的工作区，已归档会话也正确隐藏
- **会话标题稳定显示**：部分历史会话在列表时缺少投影（标题显示「未命名」，需点开才会出现），扩展现在缓存标题并对缺失投影的会话自动通过 `session/follow` 快照回填
- 启动/接管/停止/重启、主题联动、状态栏与「Open in Browser」等行为保持不变

## 降级说明

若 dsh 安装在扩展无法写入的位置（或前端结构在后续版本再次变化、补丁探测不到稳定挂点），扩展会：

1. 状态栏与侧栏保持可用（侧栏是原生列表，不依赖 GUI 分栏）；
2. 编辑器标签页改为**嵌入完整 GUI**（不传 `?dshPanel`），GUI 自带侧栏在窄于 1024px 时会自动收成图标栏；
3. 「Open in Browser」随时可用。

## 开发

```bash
npm install          # 装 @deepseek-ai/dsh 0.1.2-rc.1 与 ws
npm run compile      # tsc
npm run patch-frontend   # 把 panel-inject 打进 node_modules 内 bunded 前端（打包 vsix 前自动执行）
npm run smoke -- --cli "…/node_modules/@deepseek-ai/dsh/lib/bin.js" --home "$env:TEMP\dshvsc-smoke" --port 0
```

扩展机制概览：`src/dshManager.ts` 负责定位/spawn/接管/健康检查/API（无 vscode 依赖，可被 `src/smoke.ts` 无头验证）；`src/guiProxy.ts` 是注入浏览器 Cookie 的本地反向代理；`panel-inject.js` 是被注入 index.html 的分栏适配脚本（构建期经 `scripts/patch-frontend.mjs` 注入 bundled 前端，运行期由 `DshManager.ensurePanelSupport` 兜底）。
