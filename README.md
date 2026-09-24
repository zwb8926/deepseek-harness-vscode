# DSH for VS Code

**项目地址：https://github.com/zwb8926/deepseek-harness-vscode**

在 VS Code 中使用 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)。

本扩展**自行启动并管理 `dsh web` 服务**，并把 GUI **拆成两块**嵌入 VS Code

本次更新（版本 2026.9.24）：

- **内嵌 dsh 升级到 `@deepseek-ai/dsh@0.1.7-rc.1`**（自 0.1.7-alpha.2：0.1.7 线从 alpha 进入 **RC**，registry 上就是 `next` 标签；仍无稳定版，`latest` 还是 0.1.5-rc.3。依赖树 277 个包，前端拆分补丁随包重建；本扩展不联网自动更新，内置哪份就用哪份）

## 已知问题 / 排查

**「内测声明」弹窗点了没反应、GUI 里改设置不生效** —— 两者是同一个根因：**GUI 的设置写入被 dsh 拒绝**。

- 症状：打开新会话就弹「内测声明」，点「继续」只出现「暂时无法保存确认状态，请重试」；同时设置面板里的任何改动都不落盘。
- 服务端返回：`settings/update` → `ok=false`，`settings/rejected: "dsh: profile reload requires the root Include entry"`。
- 根因：dsh 0.1.7 把根级 `settings.yaml` 迁移成 `profiles/web/` 这套 profile 布局（旧文件被改名为 `settings.yaml.imported`），服务没能注册新布局需要的 root Include entry，于是**设置写入被拒**（能读不能写）。
- 处理：**先重启一次 dsh 服务**（重载 VS Code 窗口，或状态栏/命令里的「重启服务」）。多数情况下新进程会正常注册，之后设置可写、声明点一次即关。
- 若重启后仍被拒：扩展会自己给出判定 —— 输出面板里会出现
  `settings: the running server REJECTS settings writes` 与
  `settings-probe: a FRESH sibling …`。兄弟进程**接受**同一写入 ⇒ 是那个进程启坏了（再重启）；兄弟进程**也拒绝** ⇒ 问题在 home/CLI 侧，而不是某个进程的状态，此时可按下面的方式手动落设置。
- 手动补设置（可选，dsh 自己写的就是这个格式）：把要改的项写进 `~/.dsh/profiles/web/cordis.patch.yml` 后重启服务即可生效，例如让声明不再出现：
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
