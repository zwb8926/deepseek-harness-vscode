/**
 * LauncherViewProvider — the activity-bar sidebar panel behind the whale icon.
 *
 * The sidebar's job is session control: a "new session" entry and the server
 * status. The chat UI itself always opens as a full editor tab.
 */

import * as vscode from "vscode";
import type { DshRuntimeInfo } from "./dshManager";
import { PanelAction, launcherBody, shellHtml } from "./webviewHtml";

export class LauncherViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "dsh.launcher";

  private view?: vscode.WebviewView;
  private lastInfo?: DshRuntimeInfo;

  constructor(private readonly onAction: (action: PanelAction) => void) {}

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
