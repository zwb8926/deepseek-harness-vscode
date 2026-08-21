/**
 * ChatViewProvider — the activity-bar sidebar view that embeds the dsh web
 * GUI. Installed and activated, the extension always has visible UI: the DSH
 * icon in the activity bar, the Chat view with the embedded GUI, and the
 * status bar item.
 */

import * as vscode from "vscode";
import type { DshRuntimeInfo } from "./dshManager";
import { PanelAction, shellHtml, stateBody } from "./webviewHtml";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "dsh.chatView";

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
    this.view.webview.html = shellHtml(stateBody(this.lastInfo));
  }
}
