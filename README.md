# DSH for VS Code

**项目地址：https://github.com/zwb8926/deepseek-harness-vscode**

在 VS Code 中使用 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)。

本扩展**自行启动并管理 `dsh web` 服务**，并把 GUI **拆成两块**嵌入 VS Code：

- **左侧边栏（Launcher）**＝ GUI 的**侧栏列**（会话列表 / 工作区列表），点击活动栏的 DSH（DeepSeek 鲸鱼）图标打开
- **编辑器标签页**＝ GUI 的**中间列**（聊天 / 对话 + 右侧详情），服务启动后自动打开（Claude 式）

在侧边栏点一个会话，编辑器标签页会自动跟随切换（若编辑区未打开，会自动打开编辑区标签页）；侧边栏底部的「设置」同样在编辑区标签页打开（模态框出现在编辑区，而非窄侧栏）。两条面板共享同一会话数据。

## 命令

| 命令 | 说明 |
| --- | --- |
| `DSH: Open Chat Panel` | 在编辑器区域以标签页形式打开聊天面板 |
| `DSH: Open in Browser` | 在默认浏览器中打开运行中的 GUI |
| `DSH: Start Server` | 启动（或接管）dsh web 服务 |
| `DSH: Stop Server` | 停止自有服务（接管的外部服务不受影响） |
| `DSH: Restart Server` | 停止后重新启动 |
| `DSH: Reload Chat Panel` | 刷新嵌入式 GUI |
| `DSH: Show Logs` | 打开服务日志输出通道 |

状态栏显示服务状态，点击可打开聊天面板。

## 设置

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `dsh.home` | `""` | `DSH_HOME` 覆盖。空 = 系统默认（`~/.dsh` 或 `$DSH_HOME`） |
| `dsh.cliPath` | `""` | dsh CLI 的绝对路径（`…/node_modules/@deepseek-ai/dsh/lib/bin.js`）或 PATH 中的 `dsh` 命令。空 = 自动解析（内置安装 → PATH → 自动安装） |
| `dsh.autoStart` | `true` | VS Code 启动及打开聊天 UI 时自动启动（或接管）服务 |
| `dsh.preferNewer` | `true` | 存在多个 dsh 安装（内置 / PATH / 全局 npm）时，优先使用**最新**版本。关 = 始终用内置版本 |
| `dsh.autoUpdate` | `true` | 启动时查询 npm registry，若官方 `@deepseek-ai/dsh` 有更新版本，自动安装到扩展存储并优先使用（需 npm；离线或失败自动回退现有版本） |
| `dsh.autoRestart` | `true` | 意外退出后自动重启一次（有连续次数上限） |
| `dsh.autoInstall` | `true` | 未找到 dsh 时自动安装 `@deepseek-ai/dsh` 到扩展存储目录（随包已自带 dsh，一般不会触发） |
| `dsh.extraArgs` | `[]` | 透传给 `dsh web` 的额外命令行参数（如 `--trusted-host`） |
| `dsh.workspaceRoot` | `""` | dsh 进程的工作目录。空 = 第一个工作区文件夹 / 用户主目录 |
| `dsh.followVscodeTheme` | `true` | 内嵌 dsh UI 主题跟随 VS Code 编辑器主题（通过 `ui-theme.preference` 自动切换深/浅色），而不是跟随系统 |

## 拆分布局与面板适配

扩展通过向内嵌前端注入一段**拆分面板适配脚本**（`panel-inject.js`，幂等）实现两列 GUI：
`?dshPanel=sidebar`（侧边栏只保留会话/工作区列）与 `?dshPanel=center`（编辑区只保留聊天 + 详情列）。

直接访问 `http://127.0.0.1:3080/`（不带参数）仍是完整 GUI；浏览器内打开与 webview 内打开的模态层级一致。

面板脚本同时固定了模态框的层级（ARIA role 优先级，覆盖 settings 面板、删除确认弹窗、图片查看器等场景）：

- `[role="dialog"]` → `z-index: 2000`（删除确认等对话框，最顶层）
- `body > [role="presentation"]` → `z-index: 1600`（Modal 容器，portal 到 body）
- 编辑区模式下侧栏列（承载 settings 面板）→ `z-index: 1500`
- `[role="presentation"]` → `z-index: 1000`（settings 面板内遮罩层）

## 注意事项

- **无需 node/npm**：`@deepseek-ai/dsh` 已随扩展打包（vsix 内含完整依赖树与全部嵌套/peer 依赖，含 React 19 等）。启动时优先使用 PATH 中的 `node`；机器上**没有 node、没有 npm/npx 也能启动**——扩展宿主会用 `ELECTRON_RUN_AS_NODE=1` 把自己的运行时当 node 使用
- **端口固定 127.0.0.1:3080**：若该端口已有 dsh 服务则直接**接管**（如终端里 `npx dsh web`）
- **接管服务死亡自动接管**：接管的外部 `dsh web` 被停止后，扩展数秒内检测并自动启动自己的服务接管（受 `dsh.autoRestart` 控制，有重启次数上限；若外部服务在重启前恢复则直接重新接管）。重启预算耗尽后转为等待外部服务回归并自动重新接管。也可随时点「启动服务」手动接管
- **不自动新建会话**：新建会话在侧边栏的 GUI 内完成，扩展只打开已有的。服务启动后会把当前 VS Code 项目自动注册为 dsh workspace（`workspace.create`，幂等、不建会话）
- **接管服务自动打补丁**：接管已有服务时，扩展会自动尝试给它所依赖的 `dsh-web-frontend` 的 `index.html` 打上拆分面板补丁（npm 缓存 / 全局安装位置，服务端每次请求重读文件，无需重启）；打不上补丁时自动回退为完整 GUI
- 内嵌服务与你自己运行的 `dsh web` 共用同一 `DSH_HOME` 时会共享数据目录；如需隔离实例请设置独立的 `dsh.home`
- v2 通过 iframe 嵌入 GUI；若未来 VS Code 版本限制 webview iframe，可使用 `DSH: Open in Browser` 作为兜底

## 开发 / 打包

- 源码：`src/`（TypeScript），编译输出 `out/`
- 面板适配脚本：`panel-inject.js`（构建时经 `scripts/patch-frontend.mjs` 注入；接管服务时由 `DshManager` 运行时补丁）
- 打包：`npm run package`（`scripts/package.mjs` → `vsce`，产物 `DSH-for-VS-Code-<version>.vsix`）
- 冒烟测试：`npm run smoke`
