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
    port: getCfg("port", 3080),
    home: getCfg("home", ""),
    cliPath: getCfg("cliPath", ""),
    cwd: workspaceCwd(),
    extraArgs: getCfg("extraArgs", []),
    autoInstall: getCfg("autoInstall", true),
    autoInstallDir,
    autoRestart: getCfg("autoRestart", true),
    onInfo: (info) => {
      renderStatus(info);
      panel.update(info);
      launcher.update(info);
    },
    log
  });

  const panel = new ChatPanel(
    (action: PanelAction) => {
      void handlePanelAction(action);
    },
    context.extensionUri
  );

  // Activity-bar whale icon → sidebar panel with session controls; the chat
  // itself always opens as a full editor tab.
  const launcher = new LauncherViewProvider((action: PanelAction) => {
    void handlePanelAction(action);
  });
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

  function workspaceCwd(): string {
    const configuredRoot = getCfg("workspaceRoot", "");
    return configuredRoot !== "" ? configuredRoot : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir());
  }

  /** Refresh spawn-relevant options from settings before a start. */
  function syncOptions(): void {
    manager.configure({
      port: getCfg("port", 3080),
      home: getCfg("home", ""),
      cliPath: getCfg("cliPath", ""),
      extraArgs: getCfg("extraArgs", []),
      preferNewer: getCfg("preferNewer", true),
      autoUpdate: getCfg("autoUpdate", true),
      cwd: workspaceCwd()
    });
  }

  async function ensureStarted(): Promise<void> {
    if (manager.running) return;
    syncOptions();
    await manager.start();
  }

  async function newSession(): Promise<void> {
    if (!manager.running) {
      await ensureStarted();
    }
    if (!manager.running) return; // start failed; the error state explains why
    const sessionId = await manager.createSession();
    if (sessionId === undefined) {
      void vscode.window.showErrorMessage("创建会话失败，请查看 DeepSeek Harness 输出日志。");
      return;
    }
    log(`created session: ${sessionId}`);
    panel.open();
    panel.reload();
  }

  async function handlePanelAction(action: PanelAction): Promise<void> {
    switch (action.type) {
      case "new-session":
        await newSession();
        break;
      case "open-chat":
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
    })
  );

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
