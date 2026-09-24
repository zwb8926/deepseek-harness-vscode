# DSH for VS Code

**项目地址：https://github.com/zwb8926/deepseek-harness-vscode**

在 VS Code 中使用 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)。

本扩展**自行启动并管理 `dsh web` 服务**，并把 GUI **拆成两块**嵌入 VS Code

本次更新（版本 2026.9.24）：

- **内嵌 dsh 升级到 `@deepseek-ai/dsh@0.1.7-rc.1`**（自 0.1.7-alpha.2：0.1.7 线从 alpha 进入 **RC**，registry 上就是 `next` 标签；仍无稳定版，`latest` 还是 0.1.5-rc.3。依赖树 277 个包，前端拆分补丁随包重建；本扩展不联网自动更新，内置哪份就用哪份）
- **本版修复**：① 点会话**只在一个标签页内切换**（不再每个会话开一个窗口）；② **设置按钮可反复开关**（原先关掉一次后再点无反应：既修了适配器"任何弹窗都当作设置已开"的守卫，也修了扩展把请求投给"已被丢弃的重渲染"而不是活页面）；③ 外壳脚本此前**从未执行**（双重转义 + 常量名泄漏导致 SyntaxError），修复后 `iframe-ready` 握手与宿主↔iframe 转发恢复；④ 升级后满屏「**未命名会话**」（冷投影下 `blank=false` 的空会话被当成真会话）
- **`npm run verify` 回归套件**：9 个套件（6 离线 + 3 实时）覆盖单标签页、设置开关、外壳执行、接管未打补丁服务、生命周期 API、打包产物与启动、两种分屏不变式、每标签页会话固定、冷投影标题

## 已知问题 / 排查

**「内测声明」弹窗点了没反应、GUI 里改设置不生效** —— 两者是同一个根因：**GUI 的设置写入被 dsh 拒绝**。

- 症状：打开新会话就弹「内测声明」，点「继续」只出现「暂时无法保存确认状态，请重试」；同时设置面板里的任何改动都不落盘。
- 服务端返回：`settings/update` → `ok=false`，`settings/rejected: "dsh: profile reload requires the root Include entry"`。
- 根因：dsh 0.1.7 把根级 `settings.yaml` 迁移成 `profiles/web/` 这套 profile 布局（旧文件被改名为 `settings.yaml.imported`）。**如果服务进程正好在这次迁移过程中启动**，它不会注册新布局需要的 root Include entry，于是该进程内**所有设置写入都失败**（能读不能写）。
- 处理：**重启 dsh 服务**（重载 VS Code 窗口，或状态栏/命令里的「重启服务」）。新进程会正常注册；之后设置可写、声明点一次即关。
- 手动补确认（可选）：把这条写进 `~/.dsh/profiles/web/cordis.patch.yml` 即可让声明不再出现（dsh 自己写的就是这个格式）：
  ```yaml
  - id: ui-settings-general
    name: "@deepseek-ai/dsh-client-ui-settings-general"
    config:
      welcomeNoticeVersion: 2026-08-13.1
  ```
- 附带说明：0.1.7 把确认字段的命名空间从 `ui-onboarding` 改成了 `ui-settings-general`，所以**旧版本点过「继续」也会再弹一次**，这属于正常现象（点一次即可）。
- 与分栏适配无关：不带 `?dshPanel` 参数的原生 GUI 表现完全相同（`npm run verify -- --only notice` 会跑这条链路的对照与验收）。

## 降级说明

若 dsh 安装在扩展无法写入的位置（或前端结构在后续版本再次变化、补丁探测不到稳定挂点），扩展会：

1. 状态栏与侧栏保持可用（侧栏是原生列表，不依赖 GUI 分栏）；
2. 编辑器标签页改为**嵌入完整 GUI**（不传 `?dshPanel`），GUI 自带侧栏在窄于 1024px 时会自动收成图标栏；
3. 「Open in Browser」随时可用。
