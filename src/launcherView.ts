/**
 * LauncherViewProvider — the activity-bar sidebar behind the whale icon,
 * rendered as a custom WebviewView (the ONLY way to get hover-revealed row
 * action buttons in VS Code: the native TreeView API has no inline/hover
 * buttons, while our launcher needs dsh-sidebar-style row actions).
 *
 * Layout (same as the previous native tree):
 *   1. server status row (running/stopped/starting…) + resolved project;
 *   2. "新建会话" row — create a session in the current project and show it;
 *   3. "设置" row — open the settings modal in the editor tab;
 *   4. "工作区" group, one row per dsh workspace; each workspace EXPANDS to
 *      its bound sessions (archived sessions are hidden, like the GUI).
 *
 * Row actions appear ON HOVER (the buttons are revealed with the row):
 *   - session: 重命名 / 分叉会话 / 归档会话
 *   - workspace: 新建会话 (in that workspace, shown in the editor tab) plus
 *     a 更多 (⋯) menu with 重命名 / 删除工作区.
 *
 * The provider only renders: every action is a postMessage to the extension,
 * which owns the RPC calls (DshManager) — nothing but display runs here.
 */

import * as vscode from "vscode";
import type { DshManager } from "./dshManager";

/** A dsh session record for the launcher (title/updatedAt already extracted). */
export interface SessionInfo {
  sessionId: string;
  title: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  cwd?: string;
  turns?: number;
  steps?: number;
}

/** A dsh workspace record as returned by workspace.list. */
export interface WorkspaceInfo {
  workspaceId: string;
  path: string;
  title: string;
  sessionIds: string[];
  createdAt?: string;
  updatedAt?: string;
}

/** Launcher data snapshot pushed from the extension to the webview. */
export interface LauncherData {
  state: string;
  url?: string;
  project: string;
  workspaces: WorkspaceInfo[];
  sessions: SessionInfo[];
  archivedSessionIds: string[];
}

/** Webview → extension events. */
export type LauncherEvent =
  | { type: "reveal" }
  | { type: "click"; kind: "status" | "new-session" | "settings" | "session" | "workspace"; sessionId?: string; workspaceId?: string }
  | { type: "action"; action: "rename" | "fork" | "archive"; sessionId: string; title?: string }
  | { type: "action"; action: "new-session"; workspaceId: string }
  | { type: "action"; action: "rename-workspace" | "delete-workspace"; workspaceId: string; title?: string };

// ------------------------------------------------------------------ icons
// All glyphs are official VS Code Codicons (media/codicon.ttf + the codicon
// class list below) — native look, no hand-drawn SVGs.

const CODICONS: Record<string, string> = {
  zap: "codicon-zap",
  plus: "codicon-plus",
  gear: "codicon-gear",
  folder: "codicon-folder",
  chat: "codicon-comment",
  chatRunning: "codicon-comment-discussion",
  edit: "codicon-edit",
  fork: "codicon-git-branch",
  trash: "codicon-trash",
  more: "codicon-ellipsis"
};

const VIEW_CSS = `
@font-face { font-family: "codicon"; src: url("__CODICON_FONT_URI__") format("truetype"); }
.codicon { font-family: "codicon"; font-size: 14px; line-height: 1; speak: none; }
:root { color-scheme: light dark; }
body { margin: 0; padding: 4px 4px 8px; font-family: var(--vscode-font-family, system-ui); font-size: var(--vscode-font-size, 13px); color: var(--vscode-foreground); background: transparent; }
.launcher { display: flex; flex-direction: column; gap: 1px; }
.row {
  display: flex; align-items: center; gap: 6px;
  padding: 3px 6px; border-radius: 4px; cursor: pointer; user-select: none;
  position: relative; min-height: 22px;
}
.row:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.12)); }
.row .icon { flex: none; display: inline-flex; width: 16px; height: 16px; align-items: center; justify-content: center; color: var(--vscode-descriptionForeground); }
.row .icon.green { color: var(--vscode-charts-green, #89d185); }
.row .icon.blue { color: var(--vscode-charts-blue, #3794ff); }
.row .icon.yellow { color: var(--vscode-charts-yellow, #d7ba7d); }
.row .label { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .desc { flex: none; font-size: 11px; color: var(--vscode-descriptionForeground); }
.status-row .label { font-weight: 600; }
/* top toolbar row: 新建会话 / 设置 — ALWAYS visible, side by side */
.toolbar { display: flex; gap: 4px; padding: 2px 2px 5px; }
button.toolbtn {
  flex: 1 1 0; display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  padding: 4px 6px; border-radius: 5px; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35));
  background: var(--vscode-button-secondaryBackground, transparent);
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  font-size: 12px; cursor: pointer; min-width: 0;
}
button.toolbtn:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.18)); }
button.toolbtn .icon { width: 14px; height: 14px; }
button.toolbtn .codicon { font-size: 14px; }
.section { font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; color: var(--vscode-descriptionForeground); padding: 6px 6px 2px; }
/* hover-revealed action buttons (also pinned while its menu is open) */
.actions { flex: none; display: none; gap: 2px; align-items: center; }
.row:hover > .actions, .row:has(.more-menu.open) > .actions { display: flex; }
button.iconbtn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; border: none; background: transparent; color: inherit;
  border-radius: 4px; cursor: pointer; padding: 0;
}
button.iconbtn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.25)); }
button.iconbtn .codicon { font-size: 13px; pointer-events: none; }
.more-menu {
  position: absolute; right: 30px; top: 22px; z-index: 30; min-width: 120px;
  background: var(--vscode-menu-background, #2d2d30); border: 1px solid var(--vscode-menu-border, #454545);
  border-radius: 6px; padding: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.35);
  display: none;
}
.more-menu.open { display: block; }
.more-menu .mi { padding: 5px 8px; border-radius: 4px; cursor: pointer; white-space: nowrap; }
.more-menu .mi:hover { background: var(--vscode-menu-selectionBackground, #094771); color: var(--vscode-menu-selectionForeground, #fff); }
.more-menu .mi.danger { color: #f48771; }
.workspace .sessions { display: none; }
.workspace.open .sessions { display: block; }
.session-row { padding-left: 16px; }
.session-row .icon { width: 14px; }
.empty { padding: 4px 6px; color: var(--vscode-descriptionForeground); font-size: 12px; }
`;

// ------------------------------------------------------------------ HTML

/** Build the full launcher webview HTML (exported for smoke tests).
 * `fontUri` is the webview-accessible codicon.tft resource; `fontCsp` is the
 * CSP source to allow it (webview.cspSource). */
export function buildLauncherHtml(fontUri = "", fontCsp = ""): string {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src ${fontCsp};">
<style>${VIEW_CSS.replace(/__CODICON_FONT_URI__/g, fontUri)}</style>
</head>
<body>
<div class="launcher" id="root"><div class="empty">加载中…</div></div>
<script>
(function () {
  var vscode = acquireVsCodeApi();
  var root = document.getElementById("root");
  var expanded = {}; // workspaceId -> true (default all expanded)
  var CODICONS = ${JSON.stringify(CODICONS)};

  function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function icon(kind, cls) {
    return '<span class="codicon ' + (CODICONS[kind] || "codicon-circle-outline") + ' icon' + (cls ? " " + cls : "") + '"></span>';
  }
  function rel(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return "";
    var d = Date.now() - ms;
    if (d < 60000) return "刚刚";
    if (d < 3600000) return Math.floor(d / 60000) + " 分钟前";
    if (d < 86400000) return Math.floor(d / 3600000) + " 小时前";
    return Math.floor(d / 86400000) + " 天前";
  }

  function rowClick(ev) {
    var t = ev.target.closest ? ev.target.closest("[data-click]") : null;
    if (!t || !vscode) return;
    // Clicks inside a row's action area are handled by actionClick (and must
    // NOT also open the row). Toolbar buttons carry data-click themselves.
    if (ev.target.closest && ev.target.closest(".actions")) return;
    var msg = { type: "click", kind: t.getAttribute("data-click") };
    if (t.getAttribute("data-session")) msg.sessionId = t.getAttribute("data-session");
    if (t.getAttribute("data-ws")) msg.workspaceId = t.getAttribute("data-ws");
    vscode.postMessage(msg);
  }
  function actionClick(ev) {
    var b = ev.target.closest ? ev.target.closest("[data-action]") : null;
    if (!b || !vscode) return;
    ev.stopPropagation();
    if (b.getAttribute("data-action") === "ws-more") {
      var menu = b.parentElement && b.parentElement.querySelector(".more-menu");
      if (menu) menu.classList.toggle("open");
      return;
    }
    var msg = { type: "action", action: b.getAttribute("data-action") };
    var row = b.closest("[data-session]") || b.closest("[data-ws]");
    if (row) {
      if (row.getAttribute("data-session")) msg.sessionId = row.getAttribute("data-session");
      if (row.getAttribute("data-ws")) msg.workspaceId = row.getAttribute("data-ws");
    }
    if (b.getAttribute("data-title") !== null && b.getAttribute("data-title") !== undefined) msg.title = b.getAttribute("data-title");
    vscode.postMessage(msg);
    var menu2 = b.closest && b.closest(".more-menu");
    if (menu2) menu2.classList.remove("open");
  }
  root.addEventListener("click", rowClick);
  root.addEventListener("click", actionClick);
  document.addEventListener("click", function (e) {
    if (!e.target.closest || !e.target.closest(".more-menu")) {
      var open = document.querySelectorAll(".more-menu.open");
      for (var i = 0; i < open.length; i++) open[i].classList.remove("open");
    }
  });

  window.addEventListener("message", function (ev) {
    var d = ev.data;
    if (!d || d.type !== "data") return;
    render(d);
  });

  function render(d) {
    var out = "";
    // status row
    var state = d.state || "idle";
    var running = state === "running";
    var statusLabel = running ? "DSH 运行中" : state === "error" ? "DSH 错误" : state === "stopped" ? "DSH 已停止" : state === "starting" || state === "locating" || state === "installing" ? "DSH 启动中…" : "DSH 空闲";
    out += '<div class="row status-row" data-click="status" title="' + (running ? "DSH 状态" : "启动服务") + '">'
      + icon(running ? "zap" : "zap", running ? "green" : "")
      + '<span class="label">' + esc(statusLabel) + '</span>'
      + (d.project ? '<span class="desc">' + esc(d.project.split(/[\\\\/]/).pop() || d.project) + "</span>" : "")
      + "</div>";
    // top toolbar: 新建会话 / 设置 — one row, always visible
    out += '<div class="toolbar">'
      + '<button class="toolbtn" data-click="new-session" title="新建会话">' + icon("plus", "green") + "新建会话</button>"
      + '<button class="toolbtn" data-click="settings" title="设置">' + icon("gear", "") + "设置</button>"
      + "</div>";
    // workspaces
    out += '<div class="section">工作区</div>';
    var archived = {};
    for (var i = 0; i < (d.archivedSessionIds || []).length; i++) archived[d.archivedSessionIds[i]] = true;
    var wsItems = d.workspaces || [];
    if (wsItems.length === 0) {
      out += '<div class="empty">暂无工作区</div>';
    }
    for (var w = 0; w < wsItems.length; w++) {
      var ws = wsItems[w];
      // Only REAL sessions are listed: archived ones are hidden (like the GUI)
      // and BLANK ones (created but never used — no content yet) are hidden
      // too, exactly like the dsh sidebar's visibility rule.
      var visible = (ws.sessionIds || []).filter(function (id) {
        if (archived[id]) return false;
        if (!d.sessions) return false;
        for (var k = 0; k < d.sessions.length; k++) {
          if (d.sessions[k].sessionId === id && d.sessions[k].blank !== true) return true;
        }
        return false;
      });
      var isOpen = expanded[ws.workspaceId] !== false; // default expanded
      out += '<div class="workspace' + (isOpen ? " open" : "") + '" data-ws="' + esc(ws.workspaceId) + '">';
      out += '<div class="row ws-row" data-click="workspace" data-ws="' + esc(ws.workspaceId) + '" title="' + esc(ws.path) + '">'
        + icon("folder", "blue")
        + '<span class="label">' + esc(ws.title || (ws.path || "").split(/[\\\\/]/).pop()) + '</span>'
        + (visible.length > 0 ? '<span class="desc">' + visible.length + " 个会话</span>" : "")
        + '<span class="actions">'
        + '<button class="iconbtn" data-action="new-session" data-ws="' + esc(ws.workspaceId) + '" title="在当前工作区新建会话">' + icon("plus") + "</button>"
        + '<button class="iconbtn" data-action="ws-more" title="更多">' + icon("more") + "</button>"
        + '<span class="more-menu">'
        + '<div class="mi" data-action="rename-workspace" data-title="' + esc(ws.title || "") + '">重命名</div>'
        + '<div class="mi danger" data-action="delete-workspace">删除工作区</div>'
        + "</span>"
        + "</span></div>";
      out += '<div class="sessions">';
      if (visible.length === 0) {
        out += '<div class="empty">暂无会话</div>';
      }
      for (var s = 0; s < visible.length; s++) {
        var sid = visible[s];
        var sess = null;
        for (var k = 0; k < d.sessions.length; k++) if (d.sessions[k].sessionId === sid) { sess = d.sessions[k]; break; }
        if (!sess) continue;
        var ttl = sess.title || (sess.blank ? "新会话" : sess.sessionId.slice(0, 8));
        out += '<div class="row session-row" data-click="session" data-session="' + esc(sess.sessionId) + '" title="' + esc(ttl) + '">'
          + (sess.blank ? icon("plus", "yellow") : sess.running ? icon("chatRunning", "green") : icon("chat", ""))
          + '<span class="label">' + esc(ttl) + "</span>"
          + '<span class="desc">' + rel(sess.updatedAt) + "</span>"
          + '<span class="actions">'
          + '<button class="iconbtn" data-action="rename" data-session="' + esc(sess.sessionId) + '" data-title="' + esc(ttl) + '" title="重命名">' + icon("edit") + "</button>"
          + '<button class="iconbtn" data-action="fork" data-session="' + esc(sess.sessionId) + '" title="分叉会话">' + icon("fork") + "</button>"
          + '<button class="iconbtn" data-action="archive" data-session="' + esc(sess.sessionId) + '" title="归档会话">' + icon("trash") + "</button>"
          + "</span></div>";
      }
      out += "</div></div>";
    }
    root.innerHTML = out;
  }
})();
</script>
</body>
</html>`;
  return html;
}

// ------------------------------------------------------------------ provider

export class LauncherViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "dsh.launcher";

  private view?: vscode.WebviewView;
  private data: LauncherData = { state: "idle", url: undefined, project: "", workspaces: [], sessions: [], archivedSessionIds: [] };
  private timer?: NodeJS.Timeout;
  private refreshing = false;
  private revealed = false;

  constructor(
    private readonly manager: DshManager,
    private readonly onEvent: (event: LauncherEvent) => void,
    private readonly extensionUri: vscode.Uri,
    private readonly refreshIntervalMs = 4000
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.refresh(), this.refreshIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    this.stop();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    const fontUri = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "codicon.ttf")).toString();
    view.webview.html = buildLauncherHtml(fontUri, view.webview.cspSource);
    view.webview.onDidReceiveMessage((message: LauncherEvent) => {
      if (message === null || typeof message !== "object") return;
      this.onEvent(message);
    });
    if (!this.revealed) {
      this.revealed = true;
      this.onEvent({ type: "reveal" });
    }
    void this.refresh();
  }

  /** Called by the extension on every DshRuntimeInfo change. */
  updateState(state: string, url?: string): void {
    this.data = { ...this.data, state, url };
    void this.refresh();
  }

  /** Called when the current VS Code project changes. */
  setProject(project: string): void {
    this.data = { ...this.data, project };
    void this.refresh();
  }

  /** Pull fresh launcher data from the dsh RPCs and push it to the webview. */
  async refresh(): Promise<void> {
    if (this.refreshing || !this.manager.running) {
      // Still push state so the webview shows 已停止.
      this.push();
      return;
    }
    this.refreshing = true;
    try {
      const [sessions, baseline] = await Promise.all([
        this.manager.listSessions(),
        this.manager.listWorkspaces()
      ]);
      this.data = {
        ...this.data,
        sessions: (sessions ?? this.data.sessions).map((s) => ({
          sessionId: s.sessionId,
          title: s.title !== undefined && s.title !== "" ? s.title : s.blank ? "新会话" : s.sessionId.slice(0, 8),
          updatedAt: s.updatedAt,
          running: s.running ?? false,
          blank: s.blank ?? true,
          cwd: s.cwd,
          turns: s.turns,
          steps: s.steps
        })).sort((a, b) => b.updatedAt - a.updatedAt),
        workspaces: baseline !== undefined ? baseline.items.map((w) => ({ ...w })) : this.data.workspaces,
        archivedSessionIds: baseline !== undefined ? baseline.archivedSessionIds : this.data.archivedSessionIds
      };
      this.push();
    } catch {
      /* polling errors are transient; keep the last good data */
    } finally {
      this.refreshing = false;
    }
  }

  private push(): void {
    void this.view?.webview.postMessage({ type: "data", ...this.data });
  }
}
