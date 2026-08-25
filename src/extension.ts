/**
 * DeepSeek Harness for VS Code — extension entry.
 *
 * Wires the VSCode-free DshManager to the UI: commands, status bar item,
 * output channel, webview panel, and lifecycle (start/stop/restart, adopt an
 * existing server, open in browser).
 */

import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { ChatPanel, PanelAction } from "./chatPanel";
import { DshManager, DshRuntimeInfo } from "./dshManager";
import { LauncherEvent, LauncherViewProvider } from "./launcherView";

function getCfg<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration("dsh").get<T>(key, fallback);
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("DeepSeek Harness");
  const log = (line: string) => output.appendLine(line);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  statusBar.name = "DeepSeek Harness";
  statusBar.command = "dsh.openChat";
  statusBar.show();
  context.subscriptions.push(statusBar);

  const autoInstallDir = path.join(context.globalStorageUri.fsPath, "dsh-cli");

  const manager = new DshManager({
    port: 3080,
    home: getCfg("home", ""),
    cliPath: getCfg("cliPath", ""),
    cwd: workspaceCwd(),
    extraArgs: getCfg("extraArgs", []),
    autoInstall: getCfg("autoInstall", true),
    autoInstallDir,
    autoRestart: getCfg("autoRestart", true),
    watchExternal: getCfg("autoStart", true),
    onInfo: (info) => {
      renderStatus(info);
      panel.update(info);
      launcherView.updateState(info.state, info.url);
      if (info.state === "running" && info.url !== undefined) {
        // 把当前 VS Code 项目注册为 dsh workspace（workspace.create 幂等，
        // 不创建会话）——侧栏的 workspace 分组立即可见该项目。
        void ensureProjectWorkspace();
        // Note: do NOT auto-open the chat editor tab here. The tab is
        // opened only when the user clicks the status bar (`dsh.openChat`)
        // or a session in the launcher sidebar. Auto-starting the server
        // and registering the workspace are silent background actions.
        // Push the current VS Code theme into the dsh UI so the embedded
        // webview matches the user's color preference.
        void syncTheme();
        // Populate the launcher immediately when the server is up.
        void launcherView.refresh();
      }
    },
    log
  });

  const panel = new ChatPanel(
    (action: PanelAction) => {
      void handlePanelAction(action);
    },
    context.extensionUri,
    // The editor tab is the only place where a "current session" makes
    // sense — when the user closes the tab there is no conversation
    // panel left. (The native tree always shows its own state; nothing
    // else needs to be told.)
    () => {
      /* editor tab closed — tree keeps its own highlight-free state */
    },
    // A new editor tab is opening (or an existing one is being
    // revealed). Nothing to push to the native tree.
    () => {
      /* editor tab opened */
    }
  );

  // Activity-bar whale icon → CUSTOM WEBVIEW launcher (hover-revealed row
  // actions: sessions get 重命名/分叉/归档, workspaces get 新建会话 + 更多
  // (重命名/删除工作区) — the native TreeView API has no hover buttons, so
  // the launcher is a WebviewView that replicates the previous layout).
  const launcherView = new LauncherViewProvider(manager, (event: LauncherEvent) => {
    void handleLauncherEvent(event);
  }, context.extensionUri);
  launcherView.start();
  const launcherProvider = vscode.window.registerWebviewViewProvider(LauncherViewProvider.viewType, launcherView, {
    webviewOptions: { retainContextWhenHidden: true }
  });
  context.subscriptions.push(launcherProvider, launcherView);
  // First reveal of the launcher (clicking the activity-bar icon): auto-start
  // the server if configured and open the chat for the first time.
  let launcherFirstReveal = true;

  // The last real conversation the user opened — used to seed the default
  // panel so it never falls back to a stale blank "new session" view.
  let lastSessionId = "";

  async function openChatInEditor(): Promise<void> {
    panel.open(lastSessionId === "" ? undefined : lastSessionId);
    if (getCfg("autoStart", true) && !manager.running) {
      await ensureStarted();
    }
  }

  /** Resolve the current VS Code project directory at click time.
   *  Order: dsh.workspaceRoot setting → the workspace folder containing the
   *  active file → the first workspace folder → the active file's directory
   *  → the user home (logged; the launcher shows the resolved path). */
  function workspaceCwd(): string {
    const configuredRoot = getCfg("workspaceRoot", "");
    if (configuredRoot !== "") return configuredRoot;
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active !== undefined && active.scheme === "file") {
      const containing = vscode.workspace.getWorkspaceFolder(active);
      if (containing !== undefined) return containing.uri.fsPath;
    }
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (folder !== undefined && folder !== "") return folder;
    if (active !== undefined && active.scheme === "file") {
      const dir = path.dirname(active.fsPath);
      if (dir !== "") return dir;
    }
    return os.homedir();
  }

  /** Refresh spawn-relevant options from settings before a start. */
  function syncOptions(): void {
    manager.configure({
      port: 3080,
      home: getCfg("home", ""),
      cliPath: getCfg("cliPath", ""),
      extraArgs: getCfg("extraArgs", []),
      preferNewer: getCfg("preferNewer", true),
      autoUpdate: getCfg("autoUpdate", true),
      watchExternal: getCfg("autoStart", true),
      cwd: workspaceCwd()
    });
  }

  async function ensureStarted(): Promise<void> {
    if (manager.running) return;
    syncOptions();
    await manager.start();
  }

  /** Surface the current VS Code project in the launcher (📁 path). */
  function refreshProject(): void {
    const project = workspaceCwd();
    manager.setProject(project);
    launcherView.setProject(project);
    log(`workspaceCwd: ${project}`);
  }

  /** Register the current VS Code project as a dsh workspace once the server
   *  is up. workspace.create is idempotent and creates no session; the GUI
   *  sidebar then shows the project group immediately, and sessions created
   *  from it are bound to the project directory (session.header.cwd). */
  let registeredProject = "";
  async function ensureProjectWorkspace(): Promise<void> {
    const project = workspaceCwd();
    if (project === "" || project === registeredProject) return;
    const workspaceId = await manager.ensureWorkspace(project);
    if (workspaceId !== undefined) {
      registeredProject = project;
      log(`project workspace ready: ${project} -> ${workspaceId}`);
    }
  }

  function isDarkTheme(): boolean {
    const kind = vscode.window.activeColorTheme.kind;
    return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
  }

  /** Push the current VS Code theme into the dsh UI (ui-theme.preference). */
  async function syncTheme(): Promise<void> {
    if (!getCfg("followVscodeTheme", true)) return;
    if (!manager.running) return;
    await manager.applyTheme(isDarkTheme() ? "dark" : "light");
  }

  /** Resolve a session's display title for its editor tab (best-effort). */
  const sessionTitleCache = new Map<string, string>();
  async function sessionTitle(sessionId: string): Promise<string | undefined> {
    const cached = sessionTitleCache.get(sessionId);
    if (cached !== undefined) return cached;
    try {
      const sessions = await manager.listSessions();
      const found = sessions?.find((s) => s.sessionId === sessionId);
      const title = found?.title ?? (found?.blank ? "新会话" : undefined);
      if (title !== undefined) sessionTitleCache.set(sessionId, title);
      return title;
    } catch {
      return undefined;
    }
  }

  async function handlePanelAction(action: PanelAction): Promise<void> {
    switch (action.type) {
      case "open-chat":
        await openChatInEditor();
        break;
      case "open-settings":
        await openSettingsFlow();
        break;
      case "start":
        await ensureStarted();
        break;
      case "stop":
        await manager.stop();
        break;
      case "restart":
        await manager.stop();
        syncOptions();
        await manager.start();
        break;
      case "reload":
        panel.reload();
        void launcherView.refresh();
        break;
      case "open-browser":
        await openInBrowser();
        break;
      case "show-logs":
        output.show(true);
        break;
    }
  }

  async function openInBrowser(): Promise<void> {
    if (manager.info.url === undefined) {
      await ensureStarted();
    }
    const url = manager.info.url;
    if (url === undefined) {
      void vscode.window.showErrorMessage("DeepSeek Harness is not running; see the output channel for details.");
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  function renderStatus(info: DshRuntimeInfo): void {
    switch (info.state) {
      case "running": {
        const port = info.url !== undefined ? new URL(info.url).port : "";
        statusBar.text = `$(server) DSH: running${port !== "" ? ` :${port}` : ""}`;
        statusBar.tooltip = `DeepSeek Harness — ${info.url ?? "running"}${info.external === true ? " (adopted external server)" : ""}`;
        statusBar.backgroundColor = undefined;
        break;
      }
      case "locating":
        statusBar.text = "$(search) DSH: locating…";
        statusBar.tooltip = "Looking for the dsh CLI";
        statusBar.backgroundColor = undefined;
        break;
      case "installing":
        statusBar.text = "$(sync~spin) DSH: installing…";
        statusBar.tooltip = "Installing @deepseek-ai/dsh into the extension storage (one-time)";
        statusBar.backgroundColor = undefined;
        break;
      case "starting":
        statusBar.text = "$(sync~spin) DSH: starting…";
        statusBar.tooltip = "Booting the dsh web server";
        statusBar.backgroundColor = undefined;
        break;
      case "error":
        statusBar.text = "$(error) DSH: error";
        statusBar.tooltip = `DeepSeek Harness error: ${info.detail ?? "unknown"}`;
        statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
        break;
      case "stopped":
      default:
        statusBar.text = "$(circle-slash) DSH: stopped";
        statusBar.tooltip = info.detail ?? "DeepSeek Harness is stopped — click to open the chat panel";
        statusBar.backgroundColor = undefined;
        break;
    }
  }

  // ---------------------------------------------------------- launcher flows

  /** Open (or create) a new conversation in the editor tab. */
  async function newSessionIn(cwd?: string): Promise<void> {
    if (!manager.running) await ensureStarted();
    const sessionId = await manager.createSession(cwd);
    if (sessionId !== undefined) {
      lastSessionId = sessionId;
      panel.openSession(sessionId, "新会话");
    }
    void launcherView.refresh();
  }

  /** Create a session inside an existing workspace and show it in the editor. */
  async function newSessionInWorkspace(workspaceId: string): Promise<void> {
    if (!manager.running) await ensureStarted();
    const sessionId = await manager.createSessionForWorkspace(workspaceId);
    if (sessionId !== undefined) {
      lastSessionId = sessionId;
      panel.openSession(sessionId, "新会话");
    } else void vscode.window.showErrorMessage("无法在当前工作区创建会话");
    void launcherView.refresh();
  }

  /** Open one conversation's own editor tab (pinned via ?session=). */
  async function openSessionFlow(sessionId: string, title?: string): Promise<void> {
    if (typeof sessionId !== "string" || sessionId === "") return;
    if (!manager.running) await ensureStarted();
    if (title === undefined) title = await sessionTitle(sessionId);
    lastSessionId = sessionId;
    panel.openSession(sessionId, title);
  }

  async function openSettingsFlow(): Promise<void> {
    if (!manager.running) await ensureStarted();
    // Single render carrying ?openSettings=1: the settings modal opens in the
    // page itself at boot — no double-render, no host-message timing. The
    // default panel is seeded with the last real session so the editor shows
    // a conversation, not a new-session view.
    panel.openSettings(lastSessionId === "" ? undefined : lastSessionId);
    // Fallback: a host message after iframe-ready re-requests the modal if a
    // later re-render (state change) clobbered the URL-param boot.
    panel.postToGui({ type: "open-settings" });
  }

  /** 重命名会话: input box → sessions.rename RPC. */
  async function renameSessionFlow(sessionId: string, currentTitle?: string): Promise<void> {
    const value = await vscode.window.showInputBox({
      prompt: "重命名会话",
      value: currentTitle ?? "",
      placeHolder: "输入新的会话名称",
      ignoreFocusOut: true
    });
    if (value === undefined) return;
    const title = value.trim();
    if (title === "") return;
    if (!manager.running) await ensureStarted();
    const ok = await manager.renameSession(sessionId, title);
    if (!ok) void vscode.window.showErrorMessage("重命名失败，请查看日志");
    void launcherView.refresh();
    // Update the editor tab title if this session's tab is open.
    panel.setPanelTitle(sessionId, title);
  }

  /** 分叉会话: session.fork, then open the child in its own tab. */
  async function forkSessionFlow(sessionId: string): Promise<void> {
    if (!manager.running) await ensureStarted();
    const childId = await manager.forkSession(sessionId);
    if (childId === undefined) {
      void vscode.window.showInformationMessage("无法分叉该会话（需要它有已完成对话）");
      return;
    }
    await launcherView.refresh();
    lastSessionId = childId;
    await panel.openSession(childId, (await sessionTitle(childId)) ?? "分叉会话");
  }

  /** 归档会话: workspace.archiveSession, then refresh (row disappears). */
  async function archiveSessionFlow(sessionId: string): Promise<void> {
    if (!manager.running) await ensureStarted();
    await manager.archiveSession(sessionId);
    void launcherView.refresh();
  }

  /** 重命名工作区: input box → workspace.rename RPC. */
  async function renameWorkspaceFlow(workspaceId: string, currentTitle?: string): Promise<void> {
    const value = await vscode.window.showInputBox({
      prompt: "重命名工作区",
      value: currentTitle ?? "",
      placeHolder: "输入新的工作区名称",
      ignoreFocusOut: true
    });
    if (value === undefined) return;
    const title = value.trim();
    if (title === "") return;
    if (!manager.running) await ensureStarted();
    const ok = await manager.renameWorkspace(workspaceId, title);
    if (!ok) void vscode.window.showErrorMessage("重命名失败，请查看日志");
    void launcherView.refresh();
  }

  /** 删除工作区: modal confirm → workspace.delete RPC. */
  async function deleteWorkspaceFlow(workspaceId: string, title?: string): Promise<void> {
    const name = title !== undefined && title !== "" ? title : "该工作区";
    const pick = await vscode.window.showWarningMessage(
      `删除工作区“${name}”？文件夹与会话记录会保留，其会话将不再按工作区分组显示。`,
      { modal: true },
      "删除"
    );
    if (pick !== "删除") return;
    if (!manager.running) await ensureStarted();
    const ok = await manager.deleteWorkspace(workspaceId);
    if (!ok) void vscode.window.showErrorMessage("删除失败，请查看日志");
    void launcherView.refresh();
  }

  /** Webview launcher events → extension flows. */
  async function handleLauncherEvent(event: LauncherEvent): Promise<void> {
    switch (event.type) {
      case "reveal": {
        if (!getCfg("autoStart", true)) break;
        if (launcherFirstReveal) {
          launcherFirstReveal = false;
          await ensureStarted().catch((err) => log(`launcher-open auto-start failed: ${String(err)}`));
          void openChatInEditor();
        } else if (!manager.running) {
          await ensureStarted().catch((err) => log(`launcher-open auto-start failed: ${String(err)}`));
        }
        void launcherView.refresh();
        break;
      }
      case "click":
        switch (event.kind) {
          case "status":
            // The status row is just a status indicator: clicking it must NOT
            // open a conversation. When the server is stopped it still starts
            // it (recovery affordance), nothing more.
            if (!manager.running) await ensureStarted();
            break;
          case "new-session":
            await newSessionIn(workspaceCwd());
            break;
          case "settings":
            await openSettingsFlow();
            break;
          case "session":
            if (event.sessionId !== undefined) await openSessionFlow(event.sessionId);
            break;
          case "workspace":
            if (event.workspaceId !== undefined) {
              if (!manager.running) await ensureStarted();
              panel.open(lastSessionId === "" ? undefined : lastSessionId);
            }
            break;
        }
        break;
      case "action":
        switch (event.action) {
          case "rename":
            if (event.sessionId !== undefined) await renameSessionFlow(event.sessionId, event.title);
            break;
          case "fork":
            if (event.sessionId !== undefined) await forkSessionFlow(event.sessionId);
            break;
          case "archive":
            if (event.sessionId !== undefined) await archiveSessionFlow(event.sessionId);
            break;
          case "new-session":
            if (event.workspaceId !== undefined) await newSessionInWorkspace(event.workspaceId);
            break;
          case "rename-workspace":
            if (event.workspaceId !== undefined) await renameWorkspaceFlow(event.workspaceId, event.title);
            break;
          case "delete-workspace":
            if (event.workspaceId !== undefined) await deleteWorkspaceFlow(event.workspaceId, event.title);
            break;
        }
        break;
    }
  }

  // ---------------------------------------------------------------- commands

  context.subscriptions.push(
    vscode.commands.registerCommand("dsh.openChat", () => openChatInEditor()),
    vscode.commands.registerCommand("dsh.openInBrowser", () => openInBrowser()),
    vscode.commands.registerCommand("dsh.start", () => ensureStarted()),
    vscode.commands.registerCommand("dsh.stop", () => manager.stop()),
    vscode.commands.registerCommand("dsh.restart", async () => {
      await manager.stop();
      syncOptions();
      await manager.start();
    }),
    vscode.commands.registerCommand("dsh.reloadPanel", () => panel.reload()),
    vscode.commands.registerCommand("dsh.showLogs", () => output.show(true)),
    // Launcher: click a session → open THAT conversation's own editor tab
    // (pinned via ?session= — one page per session).
    vscode.commands.registerCommand("dsh.openSession", (sessionId: string) => openSessionFlow(sessionId)),
    // Click a workspace → show the launcher's default editor tab.
    vscode.commands.registerCommand("dsh.openWorkspace", async (workspaceId: string) => {
      if (typeof workspaceId !== "string" || workspaceId === "") return;
      if (!manager.running) await ensureStarted();
      panel.open();
    }),
    // Launcher "新建会话": creates a session in the current project and opens its tab.
    vscode.commands.registerCommand("dsh.newSession", () => newSessionIn(workspaceCwd())),
    // Launcher "设置" row: open the default editor tab and open the dsh
    // settings modal there (handled by panel-inject open-settings).
    vscode.commands.registerCommand("dsh.openSettings", () => openSettingsFlow())
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("dsh")) return;
      log("settings changed — new values apply on the next start (port/home/args)");
    }),
    // Keep the embedded dsh UI in lockstep with the VS Code theme: push the
    // preference into dsh settings AND re-render the webview color-scheme.
    vscode.window.onDidChangeActiveColorTheme(() => {
      void syncTheme();
      panel.reload();
      void launcherView.refresh();
    }),
    // Keep the launcher's project line in sync with the active editor.
    vscode.window.onDidChangeActiveTextEditor(() => {
      refreshProject();
      void launcherView.refresh();
    })
  );

  refreshProject();

  // Auto-start after startup when enabled, so the UI is live right away.
  if (getCfg("autoStart", true)) {
    void ensureStarted()
      .catch((err) => {
        log(`auto-start failed: ${String(err)}`);
        void vscode.window.showErrorMessage(`DeepSeek Harness 自动启动失败：${String(err)}`);
      })
      .then(() => {
        log(`auto-start settled: ${manager.info.state}${manager.info.url !== undefined ? " @ " + manager.info.url : ""}`);
      });
  }

  context.subscriptions.push({
    dispose: () => {
      manager.dispose();
      output.dispose();
    }
  });

  log("DeepSeek Harness extension activated");
  log(`auto-install dir: ${autoInstallDir}`);
  log("commands: dsh.openChat / dsh.start / dsh.stop / dsh.restart / dsh.openInBrowser / dsh.showLogs");
}

export function deactivate(): void {
  /* lifecycle handled through context.subscriptions */
}
