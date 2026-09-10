# DSH for VS Code

**项目地址：https://github.com/zwb8926/deepseek-harness-vscode**

在 VS Code 中使用 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)。

本扩展**自行启动并管理 `dsh web` 服务**，并把 GUI **拆成两块**嵌入 VS Code

本次更新（版本 2026.9.10）：

- **编辑区不再出现 dsh 自己的左侧栏**（2026.9.4 的回归）：rc.1 适配把 `?dshPanel=center` 改成了「照原样渲染完整 GUI」，编辑标签页因此又显示出 dsh 的会话侧栏，与 VS Code 侧栏里的启动器重复。现在 center 模式重新隐藏它，但**不再**沿用旧的「移出屏幕 + `position: fixed`」做法（rc.1 上那套组合会让设置弹窗点不动，正是 2026.9.4 把它整段删掉的原因），改为：侧栏列保留在 DOM 与网格 track 1 中、只抑制绘制（`visibility`，而非 `display`），列内的对话框层（`<hash>_overlay` / `[role="dialog"]`）重新显形，会话列显式放到 track 1-2。设置弹窗照常从侧栏脚部触发按钮打开、居中覆盖、可点可关闭，隐藏的轨道也不占编辑区宽度
- **内嵌 dsh 升级到 `@deepseek-ai/dsh@0.1.5-rc.1`**（自 0.1.2-rc.1，依赖树与前端拆分补丁随包重建；0.1.5-rc.1 已于今日成为 registry 的 `latest`，扩展的自动更新取所有 dist-tags 的最高版本，内置即为最新，不会被降级）
- **0.1.5 前端结构变化已适配**：第三栏从 `detailsCol` 改成 **右栏 `rightbarCol`**（新增文件/文档预览、open-in-app 等面板），会话插槽从 `conversation` 移到 `main`。panel-inject 现在同时匹配两种列名，**同一份注入代码兼容 0.1.2 与 0.1.5 服务端**；侧栏 `settingsArea`/`railMark`、会话行 `sessionRow`/`rowActions`/`role=treeitem`、设置弹窗的 `overlay`/`mask`/`panel[role=dialog]`（仍内联在侧栏子树 `sidebar.settings`）、`dsh.sessions.current` 的键与载荷均逐字节核对未变
- **dockkit 标签条带的层级修正**：0.1.5 的 shell 把 dockkit 标签条也标成 `role="presentation"`，而 z-index 对 flex/grid 项同样生效，原先把「所有 `role=presentation` 提到 1000」的规则会给这条普通流内元素造出栈上下文、盖住自己的面板，现已在选择器中排除
- **会话搜索修复**：`session/search` 只返回 `{sessionId, snippet}`（0.1.2 起就是这样），旧代码读 `title`/`running` 永远为空 → 现在用 `session/list` 回填标题/工作区/运行状态，列表里没有该会话时退回 snippet
- **0.1.5 兼容性核对结论（这些无需改代码）**：`dsh web` 的 spawn 参数、`dsh web: <url>?token=…` 就绪行、`dsh-auth-<hash>` cookie 的名称/格式/HMAC 输入/凭据记录 `client-connection/browser-session`、`/api` 浏览器信任围栏、index.html 每请求重读（运行时打补丁仍然有效）、`/api/remote.mux` 流协议、`session/list` 的 `_request` 字段、`workspace/*` 与 `settings/update` 的参数形状全部未变；`workspace/list` 在 0.1.5 上**仍是 404**，继续走 `workspace/follow` 基线
- **自动更新修复（Windows 路径带空格）**：`where npm` 先返回无扩展名的 `C:\Program Files\nodejs\npm`（Git-Bash 脚本），而 `shell: true` 拼接命令行时不加引号、cmd.exe 在空格处断开，报 `'C:\Program' 不是内部或外部命令` —— `dsh.autoUpdate` 的 registry 查询因此一直失败并静默退化（自动安装同样受影响）。现在 Windows 优先解析 `npm.cmd`，`runCommand` 会为带空格的命令与参数加引号，并显式拼接 shell 命令行（顺带消掉 Node 的 DEP0190 警告）。实测日志：`auto-update: registry 0.1.5-rc.1 is not newer than 0.1.5-rc.1, nothing to do`
- **验证**：`npm run smoke` 全绿（启动/停止/接管/自动更新/拆分面板补丁/RPC/工作区/主题，对内置的 0.1.5-rc.1 CLI 实跑）；另用无头 Chrome 对真实 0.1.5 GUI 复核两种分屏——center：dsh 侧栏隐藏、会话占满整帧、右栏仍在 track 3（强制 320px 轨道实测）、设置弹窗居中置顶可关闭；sidebar：侧栏展开、中栏与右栏均隐藏（该轮直接打在 0.1.5-rc.1 服务上）；并用扩展自己的 `DshManager` 跑通建工作区/新建/重命名/列表标题/归档/主题（空白会话的分叉在 0.1.2-rc.1 与 0.1.5 上同样被拒，非回归）
- 其余行为不变：启动/接管/停止/重启、`?dshPanel=sidebar` 侧栏、主题联动、状态栏与「Open in Browser」

上一版（适配 `@deepseek-ai/dsh@0.1.2-rc.1`，版本 2026.9.4）：

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
