# DSH for VS Code

在 VS Code 中使用 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)。

本扩展**自行启动并管理 `dsh web` 服务**，将完整的 Web GUI——聊天、会话、工具调用、轨迹、审批、设置——以**编辑器标签页**的形式打开（类似 Claude Code）：点击活动栏的 DSH（DeepSeek 鲸鱼）图标，聊天界面出现在代码旁边；侧边栏只保留一个包含服务控制的小型启动器。

## 功能

- **Claude 式布局** — 活动栏鲸鱼图标点击后，聊天 UI 在编辑器区域打开（而非侧边栏）；侧边栏只显示紧凑的启动器（状态 + 启动/停止/重启/刷新/日志按钮），并自动收起
- **入口始终可见** — 活动栏鲸鱼图标、状态栏、命令面板均可打开；扩展在 VS Code 启动时激活，`dsh.autoStart` 开启时自动启动（或接管）服务
- **内嵌服务** — 首次使用时扩展会自动定位已有的 `dsh` 安装（扩展内 node_modules、PATH、全局 npm）；若未找到且 npm 可用，则自动将 `@deepseek-ai/dsh` 安装到扩展存储目录（一次性，约 200MB）。`dsh web` 以子进程方式运行并被托管（意外退出时按设置自动重启，有次数上限）
- **接管已有服务** — 若 `dsh.port` 端口上已有 dsh web 服务在运行（例如你自己启动的 3080 端口 GUI），扩展直接连接该服务，不再重复启动进程
- **完整官方 UI** — 面板以 iframe 嵌入真正的 dsh SPA（同源），会话、工具调用、审批提示、模型选择、设置、插件管理等全部功能原样可用
- **复用你的 DSH_HOME** — 默认使用与命令行相同的数据目录（`~/.dsh`），凭据、设置、profile 与会话历史共享

## 命令

| 命令 | 说明 |
| --- | --- |
| `DSH: Open Chat Panel` | 在编辑器区域以标签页形式打开嵌入式 GUI |
| `DSH: Open in Browser` | 在默认浏览器中打开运行中的 GUI |
| `DSH: Start Server` | 启动（或接管）dsh web 服务 |
| `DSH: Stop Server` | 停止自有服务（接管的外部服务不受影响） |
| `DSH: Restart Server` | 停止后重新启动 |
| `DSH: Reload Chat Panel` | 刷新嵌入式 GUI |
| `DSH: Show Logs` | 打开服务日志输出通道 |

活动栏的 **DSH** 鲸鱼图标会在编辑器打开聊天标签页并收起侧边栏；状态栏显示服务状态，点击可打开聊天。

## 设置

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `dsh.port` | `3080` | 内嵌服务端口。`0` = 由系统分配。若该端口已有 dsh 服务，则接管之 |
| `dsh.home` | `""` | `DSH_HOME` 覆盖。空 = 系统默认（`~/.dsh`） |
| `dsh.cliPath` | `""` | dsh CLI 的绝对路径（`…/@deepseek-ai/dsh/lib/bin.js`）或 PATH 中的 `dsh` 命令 |
| `dsh.autoStart` | `true` | VS Code 启动及打开聊天 UI 时自动启动（或接管）服务 |
| `dsh.autoRestart` | `true` | 意外退出后自动重启一次（有连续次数上限） |
| `dsh.autoInstall` | `true` | 未找到 dsh 时自动安装 `@deepseek-ai/dsh` 到扩展存储目录 |
| `dsh.extraArgs` | `[]` | 透传给 `dsh web` 的额外命令行参数 |
| `dsh.workspaceRoot` | `""` | dsh 进程的工作目录。空 = 第一个工作区文件夹 / 用户主目录 |

## 工作原理

```
VS Code 扩展宿主                        dsh 子进程
┌────────────────────────────┐  spawn   ┌─────────────────────────────┐
│ DshManager                 │ ───────► │ node …/dsh/lib/bin.js web   │
│  · 定位 CLI                 │ stdout   │   --host 127.0.0.1 --port N │
│  · 解析 "dsh web: URL"      │ ◄─────── │                             │
│  · 健康检查                 │          └─────────────────────────────┘
│ 编辑器内聊天面板（webview） │ iframe
│  └─ http://127.0.0.1:PORT  │ ───────►  dsh SPA，同源：
└────────────────────────────┘          /api RPC 与 WS 均通过
                                        浏览器信任围栏
```

面板的 iframe 是真正的 `http://127.0.0.1:<port>` 页面，因此其所有 `/api` 请求与 WebSocket 流均为同源，能通过 dsh 的 DNS 重绑定/跨站防护围栏。扩展没有重新实现客户端协议——官方 Web UI 原样运行。

## 开发

```bash
npm install            # 开发依赖：typescript、@types/vscode、vsce
npm run compile        # tsc → out/
```

运行扩展：

- 在 VS Code 中按 **F5**（使用 `.vscode/launch.json`，Extension Development Host），或
  ```bash
  code --extensionDevelopmentPath=D:\dswork\dsh\deepseek-harness-vscode
  ```

无头冒烟测试（不依赖 VS Code，直接验证「spawn → URL → HTTP 协议 → 停止」全链路）：

```bash
npm run smoke
# 或指定已有 dsh 安装：
node out/smoke.js --cli "C:\path\to\node_modules\@deepseek-ai\dsh\lib\bin.js"
```

打包：

```bash
npx vsce package --no-dependencies --out DSH-for-VS-Code-1.0.0.vsix
```

## 注意事项

- 内嵌服务仅绑定 `127.0.0.1`（安全默认；dsh 有意拒绝 `--host 0.0.0.0`）
- 内嵌服务与你自己运行的 `dsh web` 共用同一 `DSH_HOME` 时会共享数据目录；如需隔离实例请设置独立的 `dsh.home`
- v1 通过 iframe 嵌入 GUI；若未来 VS Code 版本限制 webview iframe，可使用 `DSH: Open in Browser` 作为兜底
