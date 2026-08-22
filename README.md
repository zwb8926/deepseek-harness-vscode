# DSH for VS Code

**项目地址：https://github.com/zwb8926/deepseekharness-for-vscode**

在 VS Code 中使用 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)。

本扩展**自行启动并管理 `dsh web` 服务**，并把 GUI **拆成两块**嵌入 VS Code（2.0 起）：

- **左侧边栏（Launcher）**＝ GUI 的**侧栏列**（会话列表 / 工作区列表），点击活动栏的 DSH（DeepSeek 鲸鱼）图标打开
- **编辑器标签页**＝ GUI 的**中间列**（聊天 / 对话 + 右侧详情），服务启动后自动打开（Claude 式）

在侧边栏点一个会话，编辑器标签页会自动跟随切换；两条面板共享同一会话数据。

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
| `dsh.home` | `""` | `DSH_HOME` 覆盖。空 = 系统默认（`~/.dsh`） |
| `dsh.cliPath` | `""` | dsh CLI 的绝对路径（`…/@deepseek-ai/dsh/lib/bin.js`）或 PATH 中的 `dsh` 命令 |
| `dsh.autoStart` | `true` | VS Code 启动及打开聊天 UI 时自动启动（或接管）服务 |
| `dsh.autoRestart` | `true` | 意外退出后自动重启一次（有连续次数上限） |
| `dsh.autoInstall` | `true` | 未找到 dsh 时自动安装 `@deepseek-ai/dsh` 到扩展存储目录（随包已自带 dsh，一般不会触发） |
| `dsh.extraArgs` | `[]` | 透传给 `dsh web` 的额外命令行参数 |
| `dsh.workspaceRoot` | `""` | dsh 进程的工作目录。空 = 第一个工作区文件夹 / 用户主目录 |

## 注意事项

- **无需 node/npm**：`@deepseek-ai/dsh` 已随扩展打包（vsix 内含完整依赖树，约 200MB）。启动时优先使用 PATH 中的 `node`；机器上**没有 node、没有 npm/npx 也能启动**——扩展宿主会用 `ELECTRON_RUN_AS_NODE=1` 把自己的运行时当 node 使用
- 内嵌服务仅绑定 `127.0.0.1:3080`（端口固定；若该端口已有 dsh 服务则直接**接管**）
- **不自动新建会话**：新建会话在侧边栏的 GUI 内完成，扩展只打开已有的
- **拆分面板**：扩展会在内嵌前端里注入一段拆分脚本（`?dshPanel=sidebar|center`，幂等）。接管已有服务时，扩展会尝试自动给它所依赖的 `dsh-web-frontend` 打补丁（npm 缓存 / 全局安装位置）；打不上补丁时自动回退为完整 GUI
- 内嵌服务与你自己运行的 `dsh web` 共用同一 `DSH_HOME` 时会共享数据目录；如需隔离实例请设置独立的 `dsh.home`
- v2 通过 iframe 嵌入 GUI；若未来 VS Code 版本限制 webview iframe，可使用 `DSH: Open in Browser` 作为兜底
