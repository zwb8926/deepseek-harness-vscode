/**
 * ChatPanel — owns the editor-area webviews that embed the dsh web GUI.
 * The shared shell HTML lives in webviewHtml.ts.
 *
 * One WebviewPanel per conversation: clicking a session in the native
 * launcher tree opens (or reveals) its OWN editor tab, pinned to that
 * session via the `?session=` URL parameter — different sessions are
 * different pages, and they do not fight over the shared localStorage
 * (panel-inject ignores selection changes on pinned frames).
 *
 * A "default" panel (no pinned session, follows the GUI's current
 * selection) is used for the plain Open Chat command / settings.
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

interface PanelHandle {
  panel: vscode.WebviewPanel;
  /** The conversation this panel is pinned to ("" = default/follows GUI). */
  sessionId: string;
  iframeReady: boolean;
  pendingMessage?: Record<string, unknown>;
}

const DEFAULT_KEY = "__default__";

export class ChatPanel {
  private readonly panels = new Map<string, PanelHandle>();
  private lastInfo?: DshRuntimeInfo;

  constructor(
    private readonly onAction: (action: PanelAction) => void,
    private readonly extensionUri: vscode.Uri,
    private readonly onDispose?: () => void,
    private readonly onOpen?: () => void
  ) {}

  /** Open (or reveal) the default panel — follows the GUI's current
   * session; used by Open Chat / status bar / settings. */
  open(): void {
    this.ensurePanel(DEFAULT_KEY, "DeepSeek Harness", "");
  }

  /** Open (or reveal) the panel pinned to one conversation. Different
   * sessions get different editor tabs. */
  openSession(sessionId: string, title?: string): void {
    if (sessionId === "") return;
    // If a panel for this session exists, reveal it and refresh the title.
    const existing = this.panels.get(sessionId);
    if (existing !== undefined) {
      if (title !== undefined && title !== "") existing.panel.title = title;
      existing.panel.reveal();
      this.renderHandle(existing);
      return;
    }
    this.ensurePanel(sessionId, title !== undefined && title !== "" ? title : "DeepSeek Harness", sessionId);
  }

  /** A panel is pinned to a session when `sessionId` is non-empty. */
  private ensurePanel(key: string, title: string, sessionId: string): void {
    const existing = this.panels.get(key);
    if (existing !== undefined) {
      existing.panel.reveal();
      this.renderHandle(existing);
      this.onOpen?.();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "dsh.chatPanel",
      title,
      // Full-width editor tab (like a file tab, Claude-style): opens in the
      // active editor group without splitting.
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: []
      }
    );
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, "media", "dsh-icon-black.png"),
      dark: vscode.Uri.joinPath(this.extensionUri, "media", "dsh-icon-white.png")
    };
    const handle: PanelHandle = { panel, sessionId, iframeReady: false };
    this.panels.set(key, handle);
    const disposables: vscode.Disposable[] = [];
    panel.onDidDispose(
      () => {
        this.panels.delete(key);
        for (const d of disposables) d.dispose();
        this.onDispose?.();
      },
      undefined,
      disposables
    );
    panel.webview.onDidReceiveMessage(
      (msg: unknown) => {
        if (msg === null || typeof msg !== "object") return;
        const payload = msg as { source?: string; type?: string };
        if (payload.source === "dsh-vscode-panel" && payload.type === "iframe-ready") {
          handle.iframeReady = true;
          this.flushPending(handle);
        }
        if (typeof (msg as PanelAction).type === "string") {
          this.onAction(msg as PanelAction);
        }
      },
      undefined,
      disposables
    );
    this.renderHandle(handle);
    this.onOpen?.();
  }

  /** Re-render every open panel (used on server state changes). */
  update(info?: DshRuntimeInfo): void {
    this.lastInfo = info;
    for (const handle of this.panels.values()) {
      this.renderHandle(handle);
    }
  }

  /** Post a host message to ONE panel (default: the default panel).
   * Queued until that panel's iframe reports ready. */
  postToGui(message: Record<string, unknown>, sessionId?: string): void {
    const key = sessionId !== undefined && sessionId !== "" ? sessionId : DEFAULT_KEY;
    const handle = this.panels.get(key);
    if (handle === undefined) return;
    handle.pendingMessage = { source: "dsh-vscode-host", ...message };
    if (handle.iframeReady) this.flushPending(handle);
  }

  private flushPending(handle: PanelHandle): void {
    if (handle.pendingMessage === undefined) return;
    const msg = handle.pendingMessage;
    handle.pendingMessage = undefined;
    void handle.panel.webview.postMessage(msg);
  }

  reload(): void {
    for (const handle of this.panels.values()) {
      this.renderHandle(handle);
    }
  }

  /** Update the editor tab title of one session's panel (rename flow). */
  setPanelTitle(sessionId: string, title: string): void {
    const handle = this.panels.get(sessionId);
    if (handle !== undefined && title !== "") handle.panel.title = title;
  }

  /** True when at least one panel is open (for "open vs create" logic). */
  get hasAny(): boolean {
    return this.panels.size > 0;
  }

  private renderHandle(handle: PanelHandle): void {
    // A fresh html means a fresh iframe (and a fresh panel-inject
    // listener) — wait for the next iframe-ready before delivering
    // host messages. The pending message survives the re-render.
    handle.iframeReady = false;
    handle.panel.webview.html = shellHtml(stateBody(this.lastInfo, handle.sessionId), vscodeThemeDark());
  }
}
