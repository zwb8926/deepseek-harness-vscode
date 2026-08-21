/**
 * LauncherViewProvider — the activity-bar sidebar view.
 *
 * Clicking the DSH (whale) icon in the activity bar shows this launcher and
 * immediately opens the real chat UI as an editor tab (Claude-like), then
 * closes the sidebar. The launcher itself only holds the server state and
 * control buttons; the embedded GUI lives exclusively in the editor panel.
 */

import * as vscode from "vscode";
import type { DshRuntimeInfo } from "./dshManager";
import { PanelAction, launcherBody, shellHtml } from "./webviewHtml";

export class LauncherViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "dsh.launcher";

  private view?: vscode.WebviewView;
  private lastInfo?: DshRuntimeInfo;

  constructor(
    private readonly onAction: (action: PanelAction) => void,
    private readonly onVisible: () => void
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
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.onVisible();
    });
    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
    this.render();
  }

  update(info?: DshRuntimeInfo): void {
    this.lastInfo = info;
    this.render();
  }

  reload(): void {
    this.render();
  }

  private render(): void {
    if (this.view === undefined) return;
    this.view.webview.html = shellHtml(launcherBody(this.lastInfo));
  }
}
