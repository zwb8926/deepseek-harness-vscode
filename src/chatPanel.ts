/**
 * ChatPanel — owns the editor-area webview that embeds the dsh web GUI.
 * The shared shell HTML lives in webviewHtml.ts.
 *
 * ONE editor tab, switching conversations in place: clicking a session in the
 * launcher (or in the GUI's own sidebar) re-renders this same panel pinned to
 * that session via the `?session=` URL parameter. Opening a session never
 * creates a second tab — the panel is revealed (brought to the front) and its
 * `sessionId` is swapped, so the whole workflow stays in one window.
 *
 * The panel created without a pinned session (the plain Open Chat command /
 * settings flow) follows the GUI's current selection: it is seeded once with
 * the last known session and then tracks `dsh.sessions.current`.
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
  /** The conversation this panel is pinned to ("" = follows the GUI). */
  sessionId: string;
  iframeReady: boolean;
  pendingMessage?: Record<string, unknown>;
  /** Seed the selection once (no pinning) on the next render. */
  seedSessionId?: string;
  /** Auto-open the settings modal in the loaded page (URL param). */
  openSettings?: boolean;
}

/** The single editor tab every session is shown in. */
const DEFAULT_KEY = "__default__";
/** Title used when no conversation is pinned (or its title is unknown). */
const DEFAULT_TITLE = "DeepSeek Harness";

export class ChatPanel {
  private readonly panels = new Map<string, PanelHandle>();
  private lastInfo?: DshRuntimeInfo;

  constructor(
    private readonly onAction: (action: PanelAction) => void,
    private readonly extensionUri: vscode.Uri,
    private readonly onDispose?: () => void,
    private readonly onOpen?: () => void
  ) {}

  /** Open (or reveal) the chat tab — the default, GUI-following view.
   * `seedSessionId` points the panel at a known-good conversation so the
   * editor never falls back to a stale blank "new session" view;
   * `openSettings` auto-opens the settings modal in the loaded page. */
  open(seedSessionId?: string, openSettings = false): void {
    this.ensurePanel(DEFAULT_KEY, DEFAULT_TITLE, "", { seedSessionId, openSettings });
  }

  /** Convenience: open the chat tab with the settings modal. */
  openSettings(seedSessionId?: string): void {
    this.open(seedSessionId, true);
  }

  /** Show one conversation in the SAME editor tab: reveal it and re-render it
   * pinned to `sessionId`. No second tab is ever created. */
  openSession(sessionId: string, title?: string): void {
    if (sessionId === "") return;
    const named = title !== undefined && title !== "" ? title : undefined;
    const existing = this.panels.get(DEFAULT_KEY);
    if (existing !== undefined) {
      // Switching conversations on a live panel: swap the pin, drop any
      // stale seed, and re-render so the iframe loads that session.
      existing.sessionId = sessionId;
      existing.seedSessionId = undefined;
      existing.openSettings = false;
      if (named !== undefined) existing.panel.title = named;
      else if (existing.panel.title !== DEFAULT_TITLE) existing.panel.title = DEFAULT_TITLE;
      existing.panel.reveal();
      this.renderHandle(existing);
      this.onOpen?.();
      return;
    }
    this.ensurePanel(DEFAULT_KEY, named ?? DEFAULT_TITLE, sessionId, undefined);
  }

  /** A panel is pinned to a session when `sessionId` is non-empty. */
  private ensurePanel(key: string, title: string, sessionId: string, opts?: { seedSessionId?: string; openSettings?: boolean }): void {
    const existing = this.panels.get(key);
    if (existing !== undefined) {
      existing.panel.reveal();
      this.renderHandle(existing, opts);
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
    this.renderHandle(handle, opts);
    this.onOpen?.();
  }

  /** Re-render every open panel (used on server state changes). */
  update(info?: DshRuntimeInfo): void {
    this.lastInfo = info;
    for (const handle of this.panels.values()) {
      this.renderHandle(handle);
    }
  }

  /** Post a host message to the chat tab. Queued until its iframe is ready.
   * `sessionId`, when given, only delivers while that conversation is the one
   * on screen — the panel is reused across sessions, so a message meant for a
   * conversation the user has since switched away from must not land in it. */
  postToGui(message: Record<string, unknown>, sessionId?: string): void {
    const handle = this.panels.get(DEFAULT_KEY);
    if (handle === undefined) return;
    if (sessionId !== undefined && sessionId !== "" && handle.sessionId !== "" && handle.sessionId !== sessionId) return;
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

  /** Update the editor tab title (rename flow). The single tab carries the
   * title of the conversation it is showing, so a rename only touches it when
   * that conversation is the one on screen. */
  setPanelTitle(sessionId: string, title: string): void {
    const handle = this.panels.get(DEFAULT_KEY);
    if (handle === undefined || title === "") return;
    if (handle.sessionId === sessionId || handle.sessionId === "") handle.panel.title = title;
  }

  /** True when at least one panel is open (for "open vs create" logic). */
  get hasAny(): boolean {
    return this.panels.size > 0;
  }

  private renderHandle(handle: PanelHandle, opts?: { seedSessionId?: string; openSettings?: boolean }): void {
    if (opts !== undefined) {
      if (opts.seedSessionId !== undefined) handle.seedSessionId = opts.seedSessionId;
      if (opts.openSettings === true) handle.openSettings = true;
    }
    // A fresh html means a fresh iframe (and a fresh panel-inject
    // listener) — wait for the next iframe-ready before delivering
    // host messages. The pending message survives the re-render.
    handle.iframeReady = false;
    // openSettings is one-shot: the settings modal opens on THIS load only,
    // so later re-renders (server state changes) do not reopen it.
    const openSettings = handle.openSettings === true;
    if (openSettings) handle.openSettings = false;
    handle.panel.webview.html = shellHtml(
      stateBody(this.lastInfo, handle.sessionId, { seedSession: handle.seedSessionId, openSettings }),
      vscodeThemeDark()
    );
  }
}
