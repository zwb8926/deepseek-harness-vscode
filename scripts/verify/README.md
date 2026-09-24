# 验证套件 / verification suite

`npm run verify` —— 每个检查都是本目录下**独立可跑**的脚本，`run.mjs` 只负责顺序执行、汇总结果。
全部只用 Node 内置模块，跑的是仓库里编译好的 `out/`（即真正会打包的代码）。

```bash
npm run verify                      # 离线套件 + 能连上服务时自动带上实时套件
npm run verify -- --offline         # 只跑离线套件
npm run verify -- --only panels     # 只跑一个
npm run verify -- http://127.0.0.1:3080
```

| 套件 | 类型 | 检查什么 |
|---|---|---|
| `panel-tabs` | 离线 | **单标签页**：点会话只切换不新开窗口、切 pin、标题跟随、重命名作用域、消息路由、关掉后重建 |
| `settings-flow` | 离线(+实时) | **设置按钮可反复开关**：桩宿主模拟"相同 html 被丢弃/每次重载"两种语义下的投递；有服务时再在真浏览器里连开连关 3 轮（含"残留弹窗"陷阱） |
| `shell-check` | 离线 | 生成的外壳页**真的会执行**：bootstrap 生效（`dsh-no-tab` + 注入样式）、`iframe-ready` 握手送达、无 JS 报错 |
| `adopt-unpatched` | 离线 | **接管未打补丁的外部服务**：裸起服务 → 确认页面无适配器 → manager 接管后运行时打补丁、`panelSupport=true` |
| `feature-check` | 离线 | 工作区/会话创建、重命名、**标题投影回填**、归档、主题、搜索回退；空白会话不可分叉（harness 规则） |
| `notice` | 离线 | **设置写入链路 + 内测声明确认**：新会话会弹声明（对照）→ `settings/update` 接受确认并写到 `profiles/web/cordis.patch.yml` → 新会话不再弹 → 重启后写入依旧正常 |
| `package-check` | 离线 | **打包产物**：版本、内置 dsh、适配器与仓库逐字节一致、LibreOffice payload 已裁掉，并**从解压树真启动一次 dsh** |
| `panels` | 实时 | **分屏不变式**（真浏览器）：center = 侧栏列被涂抹隐藏且会话占满宽度、设置弹窗仍能盖在上面打开/关闭；sidebar = 只留侧栏、会话/详情列归零 |
| `pin` | 实时 | **每标签页会话固定**：`?session=` 在启动前写入 `dsh.sessions.current`，且应用确实开在该会话（`document.title` 跟随） |
| `titles` | 实时* | **冷投影下的标题**：复制 `$DSH_HOME/sessions` 成冷库 → 用**生成产物里抠出来的** `sessionLabel`/`isListable` 判定，确保不再出现「未命名会话」；回填后投影转热 |

\* `titles` 不访问线上服务，只需要一个有会话的 home（默认 `~/.dsh`）。

## 环境变量

| 变量 | 用途 | 默认 |
|---|---|---|
| `DSH_HOME` | 会话库 / `.credentials.yaml` 所在 home | `~/.dsh` |
| `DSH_VERIFY_ORIGIN` | 实时套件要打的服务地址 | `http://127.0.0.1:3080` |
| `DSH_VERIFY_CHROME` | 浏览器套件用的 Chrome/Chromium 可执行文件 | 常见安装路径自动探测 |

缺 Chrome、没有服务、没有 vsix、没有会话库时，对应套件会**打印 skip 并以 0 退出**，不会伪装成通过。
凭证由 `harness.mjs` 用 `.credentials.yaml` 里的 `browser-session` 密钥本地签发，不需要登录。

## 约定

- **每个套件自己起服务、用临时 home**（`mkTempHome()`），绝不碰你的 `~/.dsh`（`titles` 只读复制）。
- 唯一的例外是 `adopt-unpatched`：它会临时剥掉**仓库内**前端的适配器再让 manager 补回，结束时确保恢复成已打补丁状态。
- 断言用的规则尽量**从生成产物里抠出来跑**（`titles` 的 `sessionLabel`、`panel-tabs` 的真 `ChatPanel`），避免测的是"我以为的实现"。
