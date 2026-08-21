/**
 * LauncherViewProvider — the activity-bar view behind the whale icon.
 *
 * VS Code requires an activity-bar icon to own at least one view, but the
 * desired UX is Claude-like: clicking the icon opens the chat as an editor
 * tab and leaves no plugin content in the sidebar. This view therefore
 * renders an empty page and, the moment it becomes visible, opens the chat
 * panel and closes the sidebar again — an imperceptible flash at most.
 */

import * as vscode from "vscode";

export class LauncherViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "dsh.launcher";

  private view?: vscode.WebviewView;

  constructor(private readonly onVisible: () => void) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: []
    };
    // Empty content: the sidebar must never show plugin UI.
    webviewView.webview.html = "<!DOCTYPE html><html><body></body></html>";
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.onVisible();
    });
    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
  }
}
