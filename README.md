# DSH for VS Code

**项目地址：https://github.com/zwb8926/deepseek-harness-vscode**

在 VS Code 中使用 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)。

本扩展**自行启动并管理 `dsh web` 服务**，并把 GUI **拆成两块**嵌入 VS Code

本次更新（版本 2026.9.10）：

- **内嵌 dsh 升级到 `@deepseek-ai/dsh@0.1.5-rc.1`**（自 0.1.2-rc.1，依赖树与前端拆分补丁随包重建；0.1.5-rc.1 是发布时的 registry `latest`，内置即为最新）
- **0.1.5 前端结构变化已适配**：第三栏从 `detailsCol` 改成 **右栏 `rightbarCol`**（新增文件/文档预览、open-in-app 等面板），会话插槽从 `conversation` 移到 `main`。panel-inject 现在同时匹配两种列名，**同一份注入代码兼容 0.1.2 与 0.1.5 服务端**；侧栏 `settingsArea`/`railMark`、会话行 `sessionRow`/`rowActions`/`role=treeitem`、设置弹窗的 `overlay`/`mask`/`panel[role=dialog]`（仍内联在侧栏子树 `sidebar.settings`）、`dsh.sessions.current` 的键与载荷均逐字节核对未变
- **dockkit 标签条带的层级修正**：0.1.5 的 shell 把 dockkit 标签条也标成 `role="presentation"`，而 z-index 对 flex/grid 项同样生效，原先把「所有 `role=presentation` 提到 1000」的规则会给这条普通流内元素造出栈上下文、盖住自己的面板，现已在选择器中排除
- **会话搜索修复**：`session/search` 只返回 `{sessionId, snippet}`（0.1.2 起就是这样），旧代码读 `title`/`running` 永远为空 → 现在用 `session/list` 回填标题/工作区/运行状态，列表里没有该会话时退回 snippet
- **0.1.5 兼容性核对结论（这些无需改代码）**：`dsh web` 的 spawn 参数、`dsh web: <url>?token=…` 就绪行、`dsh-auth-<hash>` cookie 的名称/格式/HMAC 输入/凭据记录 `client-connection/browser-session`、`/api` 浏览器信任围栏、index.html 每请求重读（运行时打补丁仍然有效）、`/api/remote.mux` 流协议、`session/list` 的 `_request` 字段、`workspace/*` 与 `settings/update` 的参数形状全部未变；`workspace/list` 在 0.1.5 上**仍是 404**，继续走 `workspace/follow` 基线
- **移除「自动更新内置版本」**：不再在启动时查询 npm registry 并把新版 `@deepseek-ai/dsh` 装进扩展存储。设置项 `dsh.autoUpdate`、`DshManager` 的 `autoUpdate` 选项以及背后的 `maybeAutoUpdate` / `npmRegistryVersion` 全部删除——dsh 版本只由打包时内置的那份决定（`dsh.preferNewer` 仍可在**已存在**的多个安装之间挑最新，`dsh.autoInstall` 仍保留为「一个都找不到时」的兜底，两者都不会主动去 registry 拉新版本）。`smoke` 里新增断言：解析过程**不得**出现任何 npm registry 访问
- **npm 路径修复（Windows 带空格）**：`where npm` 先返回无扩展名的 `C:\Program Files\nodejs\npm`（Git-Bash 脚本），而 `shell: true` 拼接命令行时不加引号、cmd.exe 在空格处断开，报 `'C:\Program' 不是内部或外部命令` —— 自动安装与全局安装探测因此一直失败。现在 Windows 优先解析 `npm.cmd`，`runCommand` 会为带空格的命令与参数加引号，并显式拼接 shell 命令行（顺带消掉 Node 的 DEP0190 警告）
- **验证**：`npm run smoke` 全绿（启动/停止/接管/解析不碰 registry/拆分面板补丁/RPC/工作区/主题，对内置的 0.1.5-rc.1 CLI 实跑）；另用无头 Chrome 对真实 0.1.5 GUI 复核两种分屏——center：dsh 侧栏隐藏、会话占满整帧、右栏仍在 track 3（强制 320px 轨道实测）、设置弹窗居中置顶可关闭；sidebar：侧栏展开、中栏与右栏均隐藏（该轮直接打在 0.1.5-rc.1 服务上）；并用扩展自己的 `DshManager` 跑通建工作区/新建/重命名/列表标题/归档/主题（空白会话的分叉在 0.1.2-rc.1 与 0.1.5 上同样被拒，非回归）
- 其余行为不变：启动/接管/停止/重启、`?dshPanel=sidebar` 侧栏、主题联动、状态栏与「Open in Browser」

## 降级说明

若 dsh 安装在扩展无法写入的位置（或前端结构在后续版本再次变化、补丁探测不到稳定挂点），扩展会：

1. 状态栏与侧栏保持可用（侧栏是原生列表，不依赖 GUI 分栏）；
2. 编辑器标签页改为**嵌入完整 GUI**（不传 `?dshPanel`），GUI 自带侧栏在窄于 1024px 时会自动收成图标栏；
3. 「Open in Browser」随时可用。
