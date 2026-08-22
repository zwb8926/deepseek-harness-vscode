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
import { LauncherViewProvider } from "./chatView";
import { DshManager, DshRuntimeInfo } from "./dshManager";

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
      launcher.update(info);
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
    // panel left. Ask the launcher to drop its selected highlight so
    // the sidebar does not show a session as active that has no
    // editor tab open anywhere.
    () => {
      launcher.postToGui({ type: "session-closed" });
    },
    // A new editor tab is opening (or an existing one is being
    // revealed). Restore the sidebar's normal highlight so the user
    // can see which row is currently being shown.
    () => {
      launcher.postToGui({ type: "session-opened" });
    }
  );

  // Activity-bar whale icon → sidebar panel with session controls; the chat
  // itself always opens as a full editor tab.
  let launcherFirstReveal = true;
  const launcher = new LauncherViewProvider(
    (action: PanelAction) => {
      void handlePanelAction(action);
    },
    // Whenever the launcher becomes visible:
    //   - on the first reveal of the session, start the server (if not
    //     already running) AND open the chat editor tab so the user has
    //     the conversation ready to go;
    //   - on every subsequent re-probe, just re-attempt adopt-or-start
    //     so the sidebar never stays stuck on "服务未运行" while a dsh
    //     server is reachable on port 3080. We do NOT re-open the
    //     editor tab on every visibility flip — that would pop the
    //     chat back to the front any time the user clicks the
    //     activity-bar icon.
    () => {
      if (!getCfg("autoStart", true)) return;
      if (launcherFirstReveal) {
        launcherFirstReveal = false;
        void ensureStarted()
          .catch((err) => log(`launcher-open auto-start failed: ${String(err)}`))
          .finally(() => { void openChatInEditor(); });
      } else if (!manager.running) {
        void ensureStarted().catch((err) => log(`launcher-open auto-start failed: ${String(err)}`));
      }
    }
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(LauncherViewProvider.viewType, launcher, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  async function openChatInEditor(): Promise<void> {
    panel.open();
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

  async function handlePanelAction(action: PanelAction): Promise<void> {
    switch (action.type) {
      case "open-chat":
      case "open-settings":
        await openChatInEditor();
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
        launcher.reload();
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
    vscode.commands.registerCommand("dsh.showLogs", () => output.show(true))
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
      launcher.reload();
    }),
    // Keep the launcher's project line in sync with the active editor.
    vscode.window.onDidChangeActiveTextEditor(() => {
      refreshProject();
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
