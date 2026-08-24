/**
 * ChatPanel — the VS Code editor-area webview that embeds the dsh web GUI.
 * The shared shell HTML lives in webviewHtml.ts; this class only owns the
 * WebviewPanel lifecycle.
 */

import * as vscode from "vscode";
import type { DshRuntimeInfo } from "./dshManager";
import { PanelAction, shellHtml, stateBody } from "./webviewHtml";

export { PanelAction };

/** Whether the current VS Code theme is dark (drives the webview color-scheme). */
export function vscodeThemeDark(): boolean {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
}

export class ChatPanel {
  private static readonly viewType = "dsh.chatPanel";
  private panel?: vscode.WebviewPanel;
  private lastInfo?: DshRuntimeInfo;

  constructor(
    private readonly onAction: (action: PanelAction) => void,
    private readonly extensionUri: vscode.Uri,
    /** Invoked when the editor tab is closed by the user. The launcher
     *  sidebar uses this to clear the "currently selected" highlight in
     *  the embedded dsh GUI — when there is no open editor tab, the
     *  sidebar should not show any session as selected. */
    private readonly onDispose?: () => void,
    /** Invoked when the editor tab is (re-)opened. Used by the launcher
     *  to lift the no-highlight CSS override. */
    private readonly onOpen?: () => void
  ) {}

  open(): void {
    if (this.panel === undefined) {
      this.panel = vscode.window.createWebviewPanel(
        ChatPanel.viewType,
        "DeepSeek Harness",
        // Full-width editor tab (like a file tab, Claude-style): opens in the
        // active editor group without splitting.
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: []
        }
      );
      this.panel.iconPath = {
        light: vscode.Uri.joinPath(this.extensionUri, "media", "dsh-icon-black.png"),
        dark: vscode.Uri.joinPath(this.extensionUri, "media", "dsh-icon-white.png")
      };
      const disposables: vscode.Disposable[] = [];
      this.panel.onDidDispose(
        () => {
          this.panel = undefined;
          for (const d of disposables) d.dispose();
          this.onDispose?.();
        },
        undefined,
        disposables
      );
      this.panel.webview.onDidReceiveMessage(
        (msg: unknown) => {
          if (msg !== null && typeof msg === "object" && typeof (msg as PanelAction).type === "string") {
            this.onAction(msg as PanelAction);
          }
        },
        undefined,
        disposables
      );
    } else {
      this.panel.reveal();
    }
    this.render();
    this.onOpen?.();
  }

  /** Re-render (also used as "reload panel" — a fresh iframe means a fresh page). */
  update(info?: DshRuntimeInfo): void {
    this.lastInfo = info;
    this.render();
  }

  /** Post a message to the embedded dsh GUI iframe (panel-inject.js).
   * The shell forwards host messages to the iframe, and panel-inject
   * reacts — e.g. { type: "session-selected", sessionId } makes the
   * editor show that conversation (native launcher tree click). */
  postToGui(message: Record<string, unknown>): void {
    if (this.panel === undefined) return;
    void this.panel.webview.postMessage({ source: "dsh-vscode-host", ...message });
  }

  reload(): void {
    this.render();
  }

  private render(): void {
    if (this.panel === undefined) return;
    this.panel.webview.html = shellHtml(stateBody(this.lastInfo), vscodeThemeDark());
  }
}
