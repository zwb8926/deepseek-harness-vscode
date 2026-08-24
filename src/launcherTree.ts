/**
 * LauncherTreeProvider — the activity-bar sidebar panel behind the whale
 * icon, implemented with a NATIVE VS Code TreeView (no webview / no HTML).
 *
 * Renders (top→bottom):
 *   - the server status node (running / stopped / starting / …), with a
 *     folder icon + the resolved project directory;
 *   - the "会话" group: every dsh session, with title (or id), running
 *     state, and updated time;
 *   - the "工作区" group: every dsh workspace, with its path and the
 *     sessions bound to it as children.
 *
 * Data comes from `DshManager.listSessions()` / `listWorkspaces()` (dsh
 * RPC). The view polls on an interval (`refreshIntervalMs`, default 4000ms)
 * because dsh has no push/event channel to the extension host yet.
 *
 * Interactions:
 *   - click a session → open the editor tab with the dsh conversation for
 *     that session (via the host → iframe message bridge);
 *   - click a workspace → open the editor tab fresh (workspace default);
 *   - the status node has a context menu (start / stop / restart /
 *     open browser / show logs).
 */

import * as path from "node:path";
import * as vscode from "vscode";
import type { DshManager } from "./dshManager";

/** A dsh session record as returned by session.list (title resolved from
 * projections by the provider; the raw projection object is big, so the
 * provider keeps only the fields the tree needs). */
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

type Node =
  | { kind: "status" }
  | { kind: "sessions-group" }
  | { kind: "workspaces-group" }
  | { kind: "session"; session: SessionInfo }
  | { kind: "workspace"; workspace: WorkspaceInfo };

/** Format an epoch-ms timestamp for the sidebar (short, local). */
function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

export class LauncherTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private status: { state: string; url?: string } = { state: "idle" };
  private sessions: SessionInfo[] = [];
  private workspaces: WorkspaceInfo[] = [];
  private projectPath = "";
  private timer?: NodeJS.Timeout;
  private refreshing = false;

  constructor(
    private readonly manager: DshManager,
    private readonly refreshIntervalMs = 4000
  ) {}

  /** Start the poll loop. Idempotent. */
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
    this._onDidChangeTreeData.dispose();
  }

  /** Called by the extension on every DshRuntimeInfo change. */
  updateState(state: string, url?: string): void {
    const changed = this.status.state !== state || this.status.url !== url;
    this.status = { state, url };
    if (changed) this._onDidChangeTreeData.fire(undefined);
  }

  /** Called when the current VS Code project changes. */
  setProject(project: string): void {
    if (project === this.projectPath) return;
    this.projectPath = project;
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Force an immediate refresh (e.g. on reveal, after a command). */
  async refresh(): Promise<void> {
    if (this.refreshing || !this.manager.running) return;
    this.refreshing = true;
    try {
      const [sessions, workspaces] = await Promise.all([
        this.manager.listSessions(),
        this.manager.listWorkspaces()
      ]);
      if (sessions !== undefined) this.sessions = this.decorateSessions(sessions);
      if (workspaces !== undefined) this.workspaces = workspaces.map((w) => ({ ...w }));
      this._onDidChangeTreeData.fire(undefined);
    } catch {
      /* polling errors are transient; keep the last good data */
    } finally {
      this.refreshing = false;
    }
  }

  /** Map raw session.list records into tree-friendly SessionInfo. The
   * manager already extracts title/turns/steps from the projection. */
  private decorateSessions(
    raw: Array<{ sessionId: string; updatedAt: number; cwd?: string; running?: boolean; blank?: boolean; title?: string; turns?: number; steps?: number }>
  ): SessionInfo[] {
    const out: SessionInfo[] = [];
    for (const r of raw) {
      out.push({
        sessionId: r.sessionId,
        title: r.title !== undefined && r.title !== "" ? r.title : r.blank ? "（新的空白会话）" : r.sessionId.slice(0, 8),
        updatedAt: r.updatedAt,
        running: r.running ?? false,
        blank: r.blank ?? true,
        cwd: r.cwd,
        turns: r.turns,
        steps: r.steps
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // ---------------------------------------------------------- TreeDataProvider

  getTreeItem(element: Node): vscode.TreeItem {
    switch (element.kind) {
      case "status":
        return this.statusItem();
      case "sessions-group":
        return {
          id: "group-sessions",
          label: "会话",
          collapsibleState: this.sessions.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
          description: String(this.sessions.length),
          iconPath: new vscode.ThemeIcon("comment-discussion")
        };
      case "workspaces-group":
        return {
          id: "group-workspaces",
          label: "工作区",
          collapsibleState: this.workspaces.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
          description: String(this.workspaces.length),
          iconPath: new vscode.ThemeIcon("folder-library")
        };
      case "session":
        return this.sessionItem(element.session);
      case "workspace":
        return this.workspaceItem(element.workspace);
    }
  }

  getChildren(element?: Node): Node[] {
    if (element === undefined) {
      return [{ kind: "status" }, { kind: "sessions-group" }, { kind: "workspaces-group" }];
    }
    switch (element.kind) {
      case "sessions-group":
        return this.sessions.map((session) => ({ kind: "session" as const, session }));
      case "workspaces-group":
        return this.workspaces.map((workspace) => ({ kind: "workspace" as const, workspace }));
      case "workspace": {
        // Bind sessions that live under this workspace (join on cwd or
        // sessionIds; the list API gives sessionIds per workspace).
        const ids = new Set(element.workspace.sessionIds);
        return this.sessions
          .filter((s) => ids.has(s.sessionId))
          .map((session) => ({ kind: "session" as const, session }));
      }
      default:
        return [];
    }
  }

  /** Items that are selectable → command that opens the session. */
  getParent?(element: Node): Node | undefined {
    if (element.kind === "session") {
      // Sessions appear at root level and under workspaces; the parent is
      // workspace when it matches (best-effort root otherwise).
      const ws = this.workspaces.find((w) => w.sessionIds.includes(element.session.sessionId));
      return ws !== undefined ? { kind: "workspace" as const, workspace: ws } : undefined;
    }
    if (element.kind === "workspace") return { kind: "workspaces-group" };
    return undefined;
  }

  private statusItem(): vscode.TreeItem {
    const item = new vscode.TreeItem("DeepSeek Harness", vscode.TreeItemCollapsibleState.None);
    const state = this.status.state;
    item.iconPath = new vscode.ThemeIcon(
      state === "running" ? "zap" : state === "error" ? "error" : "circle-slash"
    );
    item.description = this.status.url !== undefined ? new URL(this.status.url).host : undefined;
    switch (state) {
      case "running":
        item.label = "服务运行中";
        break;
      case "starting":
      case "locating":
      case "installing":
        item.label = "服务启动中…";
        break;
      case "error":
        item.label = "服务错误";
        break;
      case "stopped":
        item.label = "服务已停止";
        break;
      default:
        item.label = "服务空闲";
    }
    if (state === "running" && this.projectPath !== "") {
      item.label = `服务运行中（📁 ${path.basename(this.projectPath)}）`;
    }
    // Fallback: clicking the status node re-opens the chat or starts.
    item.command = {
      command: state === "running" ? "dsh.openChat" : "dsh.start",
      title: "Open"
    };
    item.contextValue = "dshStatus";
    return item;
  }

  private sessionItem(s: SessionInfo): vscode.TreeItem {
    const item = new vscode.TreeItem(s.title, vscode.TreeItemCollapsibleState.None);
    item.id = `session-${s.sessionId}`;
    item.iconPath = new vscode.ThemeIcon(s.running ? "pulse" : "archive");
    const parts: string[] = [];
    parts.push(s.running ? "进行中" : s.blank ? "空白" : "已结束");
    if (s.turns !== undefined) parts.push(`${s.turns} 轮`);
    const t = formatTime(s.updatedAt);
    if (t !== "") parts.push(t);
    item.description = parts.join(" · ");
    item.tooltip = `${s.title}\n${s.sessionId}${s.cwd !== undefined ? `\n${s.cwd}` : ""}`;
    item.command = {
      command: "dsh.openSession",
      title: "打开会话",
      arguments: [s.sessionId]
    };
    item.contextValue = "dshSession";
    return item;
  }

  private workspaceItem(w: WorkspaceInfo): vscode.TreeItem {
    const item = new vscode.TreeItem(
      w.title !== "" ? w.title : path.basename(w.path),
      vscode.TreeItemCollapsibleState.Expanded
    );
    item.id = `workspace-${w.workspaceId}`;
    item.iconPath = new vscode.ThemeIcon("folder");
    item.description = w.sessionIds.length > 0 ? `${w.sessionIds.length} 个会话` : undefined;
    item.tooltip = w.path;
    item.command = {
      command: "dsh.openWorkspace",
      title: "打开工作区",
      arguments: [w.workspaceId]
    };
    item.contextValue = "dshWorkspace";
    return item;
  }
}
