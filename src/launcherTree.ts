/**
 * LauncherTreeProvider — the activity-bar sidebar panel behind the whale
 * icon, implemented with a NATIVE VS Code TreeView (no webview / no HTML).
 *
 * Layout follows the dsh GUI sidebar column (the old iframe look): a flat,
 * clean list —
 *   1. a one-line server status row (running/stopped/starting…);
 *   2. every session as a single row: title (or "新会话") + relative age
 *      ("刚刚" / "5 分钟前" / "2 小时前" / "3 天前"), an icon shows whether
 *      it is running (pulse) or blank (new);
 *   3. the "工作区" group: one row per dsh workspace (folder icon + name),
 *      sessions bound to it show as a small count in the description.
 *
 * Data comes from `DshManager.listSessions()` / `listWorkspaces()` (dsh
 * RPC) and polls on an interval (`refreshIntervalMs`, default 4000ms) —
 * dsh has no push channel to the extension host yet, polling is the
 * chosen refresh strategy.
 *
 * Interactions:
 *   - click a session → open the editor tab for that conversation
 *     (host → iframe message bridge, handled by panel-inject.js);
 *   - click a workspace → open the editor tab;
 *   - click the status row → open chat (running) / start (stopped).
 */

import * as path from "node:path";
import * as vscode from "vscode";
import type { DshManager } from "./dshManager";

/** A dsh session record (title/turns/steps already extracted by the manager). */
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
  | { kind: "workspaces-group" }
  | { kind: "session"; session: SessionInfo }
  | { kind: "workspace"; workspace: WorkspaceInfo };

/** Short relative time, dsh-sidebar style: 刚刚 / N 分钟前 / N 小时前 / N 天前. */
function relativeTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
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

  private decorateSessions(
    raw: Array<{ sessionId: string; updatedAt: number; cwd?: string; running?: boolean; blank?: boolean; title?: string; turns?: number; steps?: number }>
  ): SessionInfo[] {
    return raw
      .map((r) => ({
        sessionId: r.sessionId,
        title: r.title !== undefined && r.title !== "" ? r.title : r.blank ? "新会话" : r.sessionId.slice(0, 8),
        updatedAt: r.updatedAt,
        running: r.running ?? false,
        blank: r.blank ?? true,
        cwd: r.cwd,
        turns: r.turns,
        steps: r.steps
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // ---------------------------------------------------------- TreeDataProvider

  getTreeItem(element: Node): vscode.TreeItem {
    switch (element.kind) {
      case "status":
        return this.statusItem();
      case "workspaces-group":
        return {
          id: "group-workspaces",
          label: "工作区",
          collapsibleState: this.workspaces.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
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
      // Flat list like the dsh sidebar: status row first, then every
      // session (no "会话" group — keeps it a clean continuous list),
      // then the workspaces group at the bottom.
      return [{ kind: "status" }, ...this.sessions.map((session) => ({ kind: "session" as const, session })), { kind: "workspaces-group" }];
    }
    switch (element.kind) {
      case "workspaces-group":
        return this.workspaces.map((workspace) => ({ kind: "workspace" as const, workspace }));
      default:
        return [];
    }
  }

  getParent?(element: Node): Node | undefined {
    if (element.kind === "workspace") return { kind: "workspaces-group" };
    return undefined;
  }

  private statusItem(): vscode.TreeItem {
    const state = this.status.state;
    const item = new vscode.TreeItem(
      state === "running" ? "DSH 运行中" : state === "error" ? "DSH 错误" : state === "stopped" ? "DSH 已停止" : state === "starting" || state === "locating" || state === "installing" ? "DSH 启动中…" : "DSH 空闲",
      vscode.TreeItemCollapsibleState.None
    );
    item.id = "status-root";
    item.iconPath = new vscode.ThemeIcon(
      state === "running" ? "zap" : state === "error" ? "error" : "circle-slash"
    );
    if (state === "running") {
      const port = this.status.url !== undefined ? new URL(this.status.url).port : "";
      item.description = this.projectPath !== "" ? `📁 ${path.basename(this.projectPath)}` : port !== "" ? `:${port}` : undefined;
    } else {
      item.description = this.status.url !== undefined ? this.status.url : undefined;
    }
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
    // Icon mirrors the dsh sidebar: active session pulses, blank is a
    // fresh "新会话" row.
    item.iconPath = new vscode.ThemeIcon(s.running ? "pulse" : s.blank ? "add" : "archive");
    item.description = relativeTime(s.updatedAt);
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
      vscode.TreeItemCollapsibleState.None
    );
    item.id = `workspace-${w.workspaceId}`;
    item.iconPath = new vscode.ThemeIcon("folder");
    if (w.sessionIds.length > 0) item.description = `${w.sessionIds.length} 个会话`;
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
