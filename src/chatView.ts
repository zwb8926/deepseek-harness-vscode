/**
 * LauncherViewProvider — the activity-bar sidebar panel behind the whale icon.
 *
 * The sidebar's job is session control: a "new session" entry and the server
 * status. The chat UI itself always opens as a full editor tab.
 */

import * as vscode from "vscode";
import type { DshRuntimeInfo } from "./dshManager";
import { PanelAction, launcherBody, shellHtml } from "./webviewHtml";
import { vscodeThemeDark } from "./chatPanel";

export class LauncherViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "dsh.launcher";

  private view?: vscode.WebviewView;
  private lastInfo?: DshRuntimeInfo;

  constructor(
    private readonly onAction: (action: PanelAction) => void,
    /** Invoked whenever the launcher becomes visible — lets the extension
     *  re-probe the port (adopt-or-start) instead of staying stuck on a stale
     *  "服务未运行" state. */
    private readonly onOpen?: () => void
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: []
    };
    webviewView.webview.onDidReceiveMessage((msg: unknown) => {
      if (msg !== null && typeof msg === "object" && typeof (msg as PanelAction).type === "string") {
        this.onAction(msg as PanelAction);
      }
    });
    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
    this.render();
    this.onOpen?.();
  }

  update(info?: DshRuntimeInfo): void {
    this.lastInfo = info;
    this.render();
  }

  reload(): void {
    this.render();
  }

  /** Post a message to the embedded dsh GUI iframe (the one that runs
   *  panel-inject.js). Used by the extension to notify the sidebar that
   *  the editor tab has been closed, so the sidebar can drop its
   *  "currently selected" highlight. */
  postToGui(message: Record<string, unknown>): void {
    const view = this.view;
    if (view === undefined) return;
    view.webview.postMessage({ source: "dsh-vscode-host", ...message });
  }

  private render(): void {
    if (this.view === undefined) return;
    this.view.webview.html = shellHtml(launcherBody(this.lastInfo), vscodeThemeDark());
  }
}
