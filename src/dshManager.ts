/**
 * DshManager — locates, spawns, supervises and stops the dsh web server.
 *
 * This module is intentionally free of any `vscode` import so it can be
 * smoke-tested headlessly (`src/smoke.ts`). The extension wires it to
 * VSCode UI through the callbacks below.
 *
 * Lifecycle:
 *   idle → locating → installing → starting → running ⇄ stopped / error
 *
 * The manager first probes the configured port: if a live dsh web server
 * already answers there, it is *adopted* (no child process owned by us).
 * Otherwise the CLI is resolved (cliPath setting → extension-bundled install
 * → PATH → auto-install) and spawned as a child process. The `dsh web: URL`
 * line on stdout is parsed to learn the real URL (port 0 = OS-assigned), the
 * HTTP root is health-checked, and an unexpected exit triggers one automatic
 * restart when enabled.
 */

import { spawn, ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

// Shared split-panel adapter shipped next to out/ (see panel-inject.js).
// The injected script reads ?dshPanel=sidebar|center and adapts the GUI.
const { PANEL_MARKER, PANEL_INJECT, injectPanelSupportHtml } = require("../panel-inject.js") as {
  PANEL_MARKER: string;
  PANEL_INJECT: string;
  injectPanelSupportHtml: (html: string) => string | null;
};

export type DshState =
  | "idle"
  | "locating"
  | "installing"
  | "starting"
  | "running"
  | "stopped"
  | "error";

export interface DshRuntimeInfo {
  state: DshState;
  /** Canonical URL of the web GUI, e.g. http://127.0.0.1:34125 */
  url?: string;
  /** True when the server was adopted (we do not own the process). */
  external?: boolean;
  /** True when the served frontend understands ?dshPanel=sidebar|center
   * (split-panel mode). False → the UI falls back to the full GUI. */
  panelSupport?: boolean;
  /** Human-readable detail, usually an error message. */
  detail?: string;
  /** The current VS Code project directory resolved at click time. */
  project?: string;
}

export interface DshOptions {
  /** Configured port; 0 = OS-assigned. */
  port: number;
  /** DSH_HOME override; empty = inherit the environment default. */
  home?: string;
  /** Absolute path to the dsh CLI (bin.js or a command), or empty. */
  cliPath?: string;
  /** Working directory of the child process. */
  cwd?: string;
  /** Extra CLI arguments forwarded to `dsh web`. */
  extraArgs?: string[];
  /** Allow auto-install into the given storage dir when no dsh is found. */
  autoInstall?: boolean;
  autoInstallDir?: string;
  /** Restart once after an unexpected exit. */
  autoRestart?: boolean;
  /** When an adopted external server disappears (e.g. a `dsh web` started in
   * a terminal is stopped), keep probing the port and re-adopt automatically
   * when it comes back (default true). Only adopts; never spawns. */
  watchExternal?: boolean;
  /** When true, among the found dsh installs pick the newest version (default true). */
  preferNewer?: boolean;
  /** When true (and preferNewer), check the npm registry on start and auto-install a newer @deepseek-ai/dsh. */
  autoUpdate?: boolean;
  /** Test hook: force this executable as the node runtime. */
  nodeExecOverride?: string;
  /** Test hook: treat nodeExecOverride as an Electron binary (ELECTRON_RUN_AS_NODE). */
  electronNode?: boolean;
  /** Called on every state transition. */
  onInfo: (info: DshRuntimeInfo) => void;
  /** Log sink. */
  log: (line: string) => void;
}

const URL_LINE = /dsh web: (https?:\/\/\S+)/;
const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_INTERVAL_MS = 400;
const RESTART_DELAY_MS = 2_000;
const MAX_AUTO_RESTARTS = 2;
/** Health watch: how often the running server is probed. */
const WATCH_INTERVAL_MS = 5_000;
/** Consecutive failed probes before the server is declared dead. */
const WATCH_FAILURES_TO_DIE = 2;

/**
 * Compare two dsh version strings (semver-ish, e.g. "0.1.0-rc.7").
 * Returns <0 when a < b, 0 when equal, >0 when a > b. Prerelease sorts
 * below the same base without a prerelease; numeric identifiers have lower
 * precedence than alphanumeric ones, per semver.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { base: number[]; pre: Array<number | string> } => {
    const [baseStr, preStr] = v.split("-", 2);
    const base = baseStr.split(".").map((n) => parseInt(n, 10) || 0);
    while (base.length < 3) base.push(0);
    const pre: Array<number | string> =
      preStr === undefined
        ? []
        : preStr.split(/[.\-]/).map((n) => (/^\d+$/.test(n) ? parseInt(n, 10) : n));
    return { base, pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.base[i] !== pb.base[i]) return pa.base[i] < pb.base[i] ? -1 : 1;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const x: number | string | undefined = pa.pre[i];
    const y: number | string | undefined = pb.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return x < y ? -1 : 1;
    } else if (typeof x === "number") {
      return 1; // numeric < alphanumeric in prerelease
    } else if (typeof y === "number") {
      return -1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export class DshManager {
  private opts: DshOptions;
  private child?: ChildProcess;
  private state: DshState = "idle";
  private url?: string;
  private external = false;
  private panelSupport?: boolean;
  private detail?: string;
  private project?: string;
  private disposed = false;
  private stopping = false;
  private autoRestartCount = 0;
  private healthTimer?: NodeJS.Timeout;
  private restartTimer?: NodeJS.Timeout;
  private startedAt = 0;
  private everRan = false;
  /** Health watch: probes the running server; detects when an adopted
   * external server dies. */
  private watchTimer?: NodeJS.Timeout;
  private healthFailures = 0;
  /** True while the manager waits for a disappeared external server to return. */
  private awaitingExternal = false;

  constructor(opts: DshOptions) {
    this.opts = opts;
    this.watchTimer = setInterval(() => {
      void this.watchTick().catch(() => {
        /* probe errors are handled inside watchTick */
      });
    }, WATCH_INTERVAL_MS);
    // Do not keep a headless process alive just for the watch.
    this.watchTimer.unref?.();
  }

  /** Update spawn-relevant options (applied on the next start). */
  configure(partial: Partial<Pick<DshOptions, "port" | "home" | "cliPath" | "extraArgs" | "cwd" | "autoInstall" | "autoRestart" | "autoInstallDir" | "preferNewer" | "autoUpdate" | "watchExternal">>): void {
    Object.assign(this.opts, partial);
  }

  get info(): DshRuntimeInfo {
    return {
      state: this.state,
      url: this.url,
      external: this.external,
      panelSupport: this.panelSupport,
      detail: this.detail,
      project: this.project
    };
  }

  /** Record the current VS Code project and refresh UI consumers. */
  setProject(project: string): void {
    this.project = project;
    this.opts.onInfo(this.info);
  }

  get running(): boolean {
    return this.state === "running";
  }

  private setState(next: DshState, detail?: string): void {
    this.state = next;
    if (detail !== undefined) this.detail = detail;
    this.opts.onInfo(this.info);
  }

  /** Probe one URL with a short timeout. Returns the response status text, or
   * undefined when the server is unreachable. */
  private probe(url: string, timeoutMs = 2_500): Promise<number | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: number | undefined): void => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        finish(res.statusCode);
        res.resume();
      });
      req.on("timeout", () => {
        finish(undefined);
        req.destroy();
      });
      req.on("error", () => finish(undefined));
    });
  }

  private async fetchRoot(url: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: string | undefined): void => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      const req = http.get(url, { timeout: 3_000 }, (res) => {
        if (res.statusCode !== 200) {
          finish(undefined);
          res.resume();
          return;
        }
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
          if (body.length > 200_000) req.destroy();
        });
        res.on("end", () => finish(body));
      });
      req.on("timeout", () => {
        finish(undefined);
        req.destroy();
      });
      req.on("error", () => finish(undefined));
    });
  }

  /** Whether the URL answers with the dsh SPA (contains the boot manifest). */
  private async isDshServer(url: string): Promise<boolean> {
    const body = await this.fetchRoot(url);
    return body !== undefined && body.includes("__DSH_BOOT__");
  }

  // ------------------------------------------------------- split-panel mode

  /**
   * Make sure the served frontend supports ?dshPanel=sidebar|center.
   *
   * The bundled install is patched at build time; adopted servers (e.g. an
   * `npx dsh web` running from the npm cache) are patched here on disk — the
   * frontend-static server re-reads index.html on every request, so the patch
   * takes effect without a restart. Returns whether the split UI can be used.
   */
  private async ensurePanelSupport(url: string): Promise<boolean> {
    try {
      const probe = url + "/?dshPanel=sidebar";
      const body = await this.fetchRoot(probe);
      if (body !== undefined && body.includes(PANEL_MARKER)) {
        if (!body.includes(PANEL_INJECT)) {
          // Split view works, but the served adapter predates the
          // session-click coordination — best-effort upgrade of the frontend
          // files on disk (the server re-reads index.html per request, so a
          // later probe picks it up without a restart).
          this.opts.log("panel: served adapter is outdated — upgrading frontend files");
          for (const file of await this.findFrontendIndexFiles()) {
            patchFrontendIndexFile(file, (line) => this.opts.log(line));
          }
        }
        this.opts.log("panel: frontend supports split panels (marker found)");
        return true;
      }
      const indexFiles = await this.findFrontendIndexFiles();
      let patchedAny = false;
      for (const file of indexFiles) {
        if (patchFrontendIndexFile(file, (line) => this.opts.log(line))) patchedAny = true;
      }
      if (patchedAny) {
        const again = await this.fetchRoot(probe);
        if (again !== undefined && again.includes(PANEL_MARKER)) {
          this.opts.log("panel: frontend patched — split panels enabled");
          return true;
        }
      }
      this.opts.log("panel: frontend has no split-panel support and could not be patched — full-GUI fallback");
      return false;
    } catch (err) {
      this.opts.log(`panel: support check failed: ${String(err)} — full-GUI fallback`);
      return false;
    }
  }

  /** Candidate dsh-web-frontend dist index.html files on disk, best effort. */
  private async findFrontendIndexFiles(): Promise<string[]> {
    const files: string[] = [];
    const push = (p: string | undefined): void => {
      if (p !== undefined && existsSync(p)) files.push(p);
    };
    // 1. The extension-bundled install (normally already patched at build time).
    push(path.join(__dirname, "..", "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist", "index.html"));
    // 2. The auto-install / auto-update directory in the extension storage.
    if (this.opts.autoInstallDir !== undefined) {
      push(path.join(this.opts.autoInstallDir, "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist", "index.html"));
    }
    // 3. A global npm install.
    const globalRoot = await npmGlobalRoot();
    if (globalRoot !== undefined) {
      push(path.join(globalRoot, "@deepseek-ai", "dsh-web-frontend", "dist", "index.html"));
    }
    // 4. The npm npx cache — the usual home of an adopted `npx dsh web` server.
    const npxRoot =
      process.platform === "win32"
        ? path.join(os.homedir(), "AppData", "Local", "npm-cache", "_npx")
        : path.join(os.homedir(), ".npm", "_npx");
    try {
      if (existsSync(npxRoot)) {
        for (const entry of readdirSync(npxRoot, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          push(path.join(npxRoot, entry.name, "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist", "index.html"));
        }
      }
    } catch (err) {
      this.opts.log(`panel: npx cache scan failed: ${String(err)}`);
    }
    return files;
  }

  /** POST one /api RPC envelope; returns the parsed response value or undefined. */
  private async rpc(method: string, payload: unknown): Promise<unknown | undefined> {
    const url = this.url;
    if (url === undefined || this.state !== "running") return undefined;
    const envelope = {
      type: "client-request",
      rpcId: `dsh-vsc-${Date.now()}`,
      method,
      payload
    };
    return new Promise((resolve) => {
      const body = JSON.stringify(envelope);
      const req = http.request(
        new URL(`${url}/api/${method}`),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body)
          },
          timeout: 15_000
        },
        (res) => {
          let text = "";
          res.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
          res.on("end", () => {
            try {
              const parsed = JSON.parse(text) as {
                result?: { ok?: boolean; value?: unknown; error?: { message?: string } };
              };
              if (parsed.result?.ok === true) resolve(parsed.result.value);
              else {
                this.opts.log(`rpc ${method} failed: ${parsed.result?.error?.message ?? text.slice(0, 200)}`);
                resolve(undefined);
              }
            } catch {
              resolve(undefined);
            }
          });
        }
      );
      req.on("timeout", () => {
        this.opts.log(`rpc ${method} timed out`);
        req.destroy();
        resolve(undefined);
      });
      req.on("error", (err) => {
        this.opts.log(`rpc ${method} error: ${String(err)}`);
        resolve(undefined);
      });
      req.end(body);
    });
  }

  /** Create a new dsh session via the running server; returns the sessionId.
   * Pass `cwd` to bind the session to a project directory (dsh workspace). */
  async createSession(cwd?: string): Promise<string | undefined> {
    const value = (await this.rpc("session.create", cwd === undefined ? {} : { cwd })) as { sessionId?: string } | undefined;
    return value?.sessionId;
  }

  /** Ensure a real workspace record exists for `path` (idempotent); returns its workspaceId. */
  async ensureWorkspace(path: string): Promise<string | undefined> {
    const value = (await this.rpc("workspace.create", { path })) as
      | { workspace?: { workspaceId?: string }; created?: boolean }
      | undefined;
    if (value?.workspace?.workspaceId === undefined) {
      this.opts.log(`ensureWorkspace: could not create/adopt workspace for ${path}`);
      return undefined;
    }
    this.opts.log(`ensureWorkspace: ${path} -> ${value.workspace.workspaceId}${value.created === true ? " (created)" : " (existing)"}`);
    return value.workspace.workspaceId;
  }

  /**
   * Create a session bound to a real workspace for `path` (the flow the GUI
   * groups by). Falls back to a bare cwd session when the workspace record
   * cannot be created.
   */
  async createSessionInWorkspace(path: string): Promise<string | undefined> {
    const workspaceId = await this.ensureWorkspace(path);
    if (workspaceId !== undefined) {
      const value = (await this.rpc("session.create", { workspaceId })) as { sessionId?: string } | undefined;
      if (value?.sessionId !== undefined) return value.sessionId;
    }
    return this.createSession(path);
  }

  /** List the real workspace records (verification/diagnostics). */
  async listWorkspaces(): Promise<Array<{ workspaceId: string; path: string; title: string; sessionIds: string[] }> | undefined> {
    const value = (await this.rpc("workspace.list", {})) as { items?: Array<{ workspaceId: string; path: string; title: string; sessionIds: string[] }> } | undefined;
    return value?.items;
  }

  /** List all sessions with their cwd and updatedAt (to find a project's session). */
  async listSessions(): Promise<Array<{ sessionId: string; updatedAt: number; cwd?: string; running?: boolean; blank?: boolean }> | undefined> {
    const value = (await this.rpc("session.list", {})) as { items?: Array<{ sessionId: string; updatedAt: number; cwd?: string; running?: boolean; blank?: boolean }> } | undefined;
    return value?.items;
  }

  /** Apply the dsh UI theme preference (ui-theme.preference) via the settings API. */
  async applyTheme(preference: "light" | "dark" | "system"): Promise<boolean> {
    const value = await this.rpc("settings.update", { ns: "ui-theme", patch: { preference } });
    if (value === undefined) {
      this.opts.log(`applyTheme: could not set ui-theme.preference=${preference}`);
      return false;
    }
    this.opts.log(`applyTheme: ui-theme.preference=${preference} applied`);
    return true;
  }

  // ------------------------------------------------------------------ start

  async start(): Promise<void> {
    if (this.disposed || this.stopping) return;
    if (this.child !== undefined || this.state === "starting" || this.state === "locating" || this.state === "installing") {
      this.opts.log("start: already starting/running, ignored");
      return;
    }
    if (this.state === "running") return;

    // 1. Adopt an existing server on the configured port.
    if (this.opts.port > 0) {
      const candidate = `http://127.0.0.1:${this.opts.port}`;
      this.opts.log(`start: probing ${candidate} for an existing dsh server…`);
      if (await this.isDshServer(candidate)) {
        this.opts.log(`start: adopting existing server at ${candidate}`);
        this.external = true;
        this.url = candidate;
        this.everRan = true;
        this.awaitingExternal = false;
        this.autoRestartCount = 0;
        this.panelSupport = await this.ensurePanelSupport(candidate);
        this.setState("running");
        return;
      }
      this.opts.log("start: nothing listening there (or not a dsh server); spawning our own");
    }

    // 2. Resolve the CLI.
    this.external = false;
    this.url = undefined;
    this.panelSupport = undefined;
    this.awaitingExternal = false;
    this.setState("locating");
    const cli = await this.resolveCli();
    if (cli === undefined) {
      this.setState("error", "dsh CLI not found. Install it (npm i -g @deepseek-ai/dsh) or set dsh.cliPath.");
      return;
    }

    // 3. Spawn `dsh web`.
    this.setState("starting");
    const args = ["web", "--host", "127.0.0.1", "--port", String(this.opts.port), "--no-open", ...(this.opts.extraArgs ?? [])];
    const env: NodeJS.ProcessEnv = { ...process.env, ...(cli.env ?? {}) };
    if (this.opts.home !== undefined && this.opts.home !== "") env.DSH_HOME = this.opts.home;
    this.opts.log(`spawn: ${cli.cmd} ${args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);
    if (cli.cwd !== undefined) {
      this.opts.log(`       cwd: ${cli.cwd}`);
      this.opts.log(`       DSH_HOME: ${env.DSH_HOME ?? "(inherit)"}`);
    }

    let child: ChildProcess;
    try {
      child = spawn(cli.cmd, cli.prefixArgs.concat(args), {
        cwd: this.opts.cwd ?? os.homedir(),
        env,
        windowsHide: true,
        shell: cli.shell === true
      });
    } catch (err) {
      // Synchronous spawn failure (bad executable, EPERM, …): surface it and
      // leave the manager in a retryable state instead of "starting" forever.
      this.opts.log(`spawn error: ${String(err)}`);
      this.setState("error", `spawn error: ${String(err)}`);
      return;
    }
    this.child = child;
    this.startedAt = Date.now();
    this.everRan = true;

    let stderrBuf = "";
    child.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrBuf = (stderrBuf + text).slice(-4000);
      this.opts.log(text.replace(/\n$/, ""));
    });
    child.on("error", (err) => {
      this.opts.log(`spawn error: ${String(err)}`);
      this.detail = `spawn error: ${String(err)}`;
      this.setState("error");
    });
    child.on("exit", (code, signal) => {
      this.child = undefined;
      const when = Date.now() - this.startedAt;
      const reason = signal !== null ? `signal ${signal}` : `code ${String(code)}`;
      this.opts.log(`dsh process exited (${reason}) after ${when}ms`);
      if (this.disposed) {
        this.setState("stopped");
        return;
      }
      if (this.stopping) {
        // Deliberate stop: the exit is expected, no auto-restart.
        this.stopping = false;
        return;
      }
      if (this.state !== "error") {
        this.setState("stopped", `dsh exited (${reason})`);
      }
      this.scheduleRestart();
    });

    // 4. Wait for the URL line (port 0 → OS-assigned) and health-check.
    await this.waitForUrl(child, 90_000);
  }

  private onStdout(text: string): void {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (line === "") continue;
      this.opts.log(line);
      const m = URL_LINE.exec(line);
      if (m !== null) {
        this.url = m[1];
        this.opts.log(`resolved GUI URL: ${this.url}`);
      }
    }
  }

  private async waitForUrl(child: ChildProcess, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.disposed && this.child === child && this.url === undefined) {
      if (Date.now() > deadline) {
        this.killChild(child);
        this.setState("error", "timed out waiting for the dsh server to report its URL");
        return;
      }
      await delay(200);
    }
    if (this.disposed || this.child !== child) return;
    const url = this.url;
    if (url === undefined) return;
    this.setState("starting");

    // Health check: the root must answer 200 with the SPA.
    const healthDeadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (!this.disposed && this.child === child) {
      const status = await this.probe(url);
      if (status === 200) {
        const ok = await this.isDshServer(url);
        if (ok) {
          this.autoRestartCount = 0;
          this.panelSupport = await this.ensurePanelSupport(url);
          this.setState("running");
          return;
        }
      }
      if (Date.now() > healthDeadline) {
        this.killChild(child);
        this.setState("error", "server started but the web UI is not answering on " + url);
        return;
      }
      await delay(HEALTH_INTERVAL_MS);
    }
  }

  /** Kill a child we still own, so a failed start cannot block a retry. */
  private killChild(child: ChildProcess): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.opts.log("killing dsh process after failed start");
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }

  private scheduleRestart(): void {
    if (this.disposed || this.restartTimer !== undefined) return;
    if (!(this.opts.autoRestart ?? true)) {
      this.opts.log("auto-restart disabled; server stays stopped");
      return;
    }
    if (this.external) return;
    if (this.autoRestartCount >= MAX_AUTO_RESTARTS) {
      this.opts.log(`auto-restart budget exhausted (${MAX_AUTO_RESTARTS}); server stays stopped — use DSH: Start Server`);
      return;
    }
    this.autoRestartCount += 1;
    this.opts.log(`unexpected exit while the panel may be open — restarting in ${RESTART_DELAY_MS}ms (attempt ${this.autoRestartCount}/${MAX_AUTO_RESTARTS})`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.disposed) return;
      void this.start().catch((err) => this.opts.log(`restart failed: ${String(err)}`));
    }, RESTART_DELAY_MS);
  }

  // -------------------------------------------------------------- health watch

  /**
   * Periodically probe the running server and watch for an external server
   * to come back:
   *   - state "running": a dead server (adopted from a terminal, or an owned
   *     process that hangs) must never keep the UI on a stale "running" —
   *     after two consecutive failed probes the state is corrected and the
   *     normal recovery paths (auto-restart / adopt / start) become live again.
   *   - awaitingExternal: an adopted server disappeared; re-adopt it as soon
   *     as it answers again (never spawns on its own).
   */
  private async watchTick(): Promise<void> {
    if (this.disposed) return;
    if (this.state === "running" && this.url !== undefined) {
      const status = await this.probe(this.url, 2_000);
      if (status === 200) {
        this.healthFailures = 0;
        return;
      }
      this.healthFailures += 1;
      if (this.healthFailures >= WATCH_FAILURES_TO_DIE) {
        this.handleHealthFailure();
      }
      return;
    }
    this.healthFailures = 0;
    if (this.awaitingExternal && this.opts.port > 0) {
      const candidate = `http://127.0.0.1:${this.opts.port}`;
      if (await this.isDshServer(candidate)) {
        this.opts.log(`watch: external dsh server is back at ${candidate} — re-adopting`);
        this.awaitingExternal = false;
        this.external = true;
        this.url = candidate;
        this.everRan = true;
        this.autoRestartCount = 0;
        this.panelSupport = await this.ensurePanelSupport(candidate);
        this.setState("running");
      }
    }
  }

  /** The watched server stopped answering: correct the stale state. */
  private handleHealthFailure(): void {
    this.healthFailures = 0;
    this.opts.log("watch: the dsh server stopped answering");
    if (this.child !== undefined) {
      // Owned process that hangs (or died without a clean exit event): kill it
      // so the exit handler transitions the state and applies the restart budget.
      this.killChild(this.child);
      return;
    }
    if (this.external) {
      this.external = false;
      this.url = undefined;
      if (this.opts.watchExternal !== false) {
        this.awaitingExternal = true;
      }
      this.setState("stopped", "external dsh service stopped — auto-restart scheduled");
      // The adopted server died exactly like an unexpected exit of our own
      // process: auto-start a replacement (or re-adopt it if it returns first).
      // Honors dsh.autoRestart and its restart budget; when the budget is
      // exhausted the watch keeps re-adopting the external server if it returns.
      this.scheduleRestart();
      return;
    }
    // Running but neither owned nor adopted — nothing to recover.
  }

  // ------------------------------------------------------------------ stop

  async stop(): Promise<void> {
    this.awaitingExternal = false;
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    if (this.external) {
      this.external = false;
      this.url = undefined;
      this.setState("stopped", "adopted external server left untouched");
      return;
    }
    const child = this.child;
    if (child === undefined) {
      if (this.state !== "idle") this.setState("stopped");
      return;
    }
    this.child = undefined;
    this.url = undefined;
    this.opts.log("stop: terminating dsh process");
    this.setState("stopped");
    child.kill();
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.opts.log("stop: force-killing dsh process");
        child.kill("SIGKILL");
        resolve();
      }, 3_000);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  // ------------------------------------------------------------- CLI resolve

  private async resolveCli(): Promise<{ cmd: string; prefixArgs: string[]; shell?: boolean; cwd?: string; env?: NodeJS.ProcessEnv } | undefined> {
    const opts = this.opts;

    // 1. Explicit setting (always respected as-is).
    const explicit = opts.cliPath?.trim() ?? "";
    if (explicit !== "") {
      const resolved = await this.resolveExplicit(explicit);
      if (resolved !== undefined) return resolved;
      this.opts.log(`resolve: dsh.cliPath "${explicit}" not usable`);
    }

    // 2. Collect candidates: bundled install, PATH `dsh`, global npm install.
    const candidates: Array<{ cmd: string; prefixArgs: string[]; shell?: boolean; env?: NodeJS.ProcessEnv; version?: string }> = [];
    const bundled = await this.locateInTree(path.join(__dirname, ".."));
    if (bundled !== undefined) candidates.push(bundled);

    const onPath = await findOnPath("dsh");
    if (onPath !== undefined) candidates.push(await this.probePathCandidate(onPath));

    const globalRoot = await npmGlobalRoot();
    if (globalRoot !== undefined) {
      const globalBin = await this.locateInTree(globalRoot);
      if (globalBin !== undefined) candidates.push(globalBin);
    }

    // 3. Auto-update: when enabled and npm is available, compare the npm
    //    registry "latest" against the best candidate; if newer, install it
    //    into the extension storage and let it win the ranking.
    if ((opts.preferNewer ?? true) && opts.autoUpdate === true && opts.autoInstallDir !== undefined) {
      await this.maybeAutoUpdate(candidates);
    }

    // 4. Pick: newest when preferNewer (default), else the bundled-first order.
    let chosen: (typeof candidates)[number] | undefined;
    if (candidates.length > 0) {
      if (opts.preferNewer ?? true) {
        chosen = [...candidates].sort((x, y) => {
          if (x.version === undefined && y.version === undefined) return 0;
          if (x.version === undefined) return 1;
          if (y.version === undefined) return -1;
          return compareVersions(y.version, x.version);
        })[0];
      } else {
        chosen = candidates[0];
      }
    }
    if (chosen !== undefined) {
      this.opts.log(
        `resolve: chose dsh v${chosen.version ?? "?"} (${candidates.map((c) => `${c.version ?? "?"}@${c.cmd}`).join(" | ")})`
      );
      return chosen;
    }

    // 5. Auto-install into the extension storage directory (no candidate at all).
    if (opts.autoInstall && opts.autoInstallDir !== undefined) {
      this.setState("installing");
      const installed = await this.autoInstall(opts.autoInstallDir);
      if (installed !== undefined) return installed;
    }

    return undefined;
  }

  /** Install the newest @deepseek-ai/dsh from the registry when it is newer than every known candidate. */
  private async maybeAutoUpdate(candidates: Array<{ version?: string }>): Promise<void> {
    const npm = await findOnPath("npm");
    if (npm === undefined) {
      this.opts.log("auto-update: npm not found, staying on bundled dsh");
      return;
    }
    const known = candidates.map((c) => c.version).filter((v): v is string => v !== undefined);
    if (known.length === 0) {
      this.opts.log("auto-update: no known dsh version to compare against");
      return;
    }
    const knownBest = [...known].sort((a, b) => compareVersions(b, a))[0];
    const latest = await this.npmRegistryVersion(npm);
    if (latest === undefined) {
      this.opts.log("auto-update: could not read the registry (offline?), staying on current dsh");
      return;
    }
    if (compareVersions(latest, knownBest) <= 0) {
      this.opts.log(`auto-update: registry ${latest} is not newer than ${knownBest}, nothing to do`);
      return;
    }
    this.opts.log(`auto-update: registry has ${latest} (> ${knownBest}) — installing into extension storage…`);
    this.setState("installing");
    const dir = this.opts.autoInstallDir!;
    const result = await runCommand(
      npm,
      ["install", "--no-fund", "--no-audit", "--prefix", dir, `@deepseek-ai/dsh@${latest}`],
      { shell: true, log: this.opts.log, timeoutMs: 15 * 60_000 }
    );
    if (!result.ok) {
      this.opts.log("auto-update: install failed, staying on the current dsh");
      return;
    }
    const installed = await this.locateInTree(dir);
    if (installed !== undefined) candidates.push(installed);
  }

  /** `npm view @deepseek-ai/dsh version` with a timeout; undefined on any failure. */
  private async npmRegistryVersion(npm: string): Promise<string | undefined> {
    const result = await runCommand(npm, ["view", "@deepseek-ai/dsh", "version"], {
      shell: true,
      capture: true,
      timeoutMs: 20_000,
      log: this.opts.log
    });
    if (!result.ok) return undefined;
    const version = (result.stdout ?? "").trim().split(/\r?\n/)[0]?.trim();
    return version !== undefined && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : undefined;
  }

  /** Probe the version of a PATH `dsh` command (best effort; unknown on failure). */
  private async probePathCandidate(cmdPath: string): Promise<{ cmd: string; prefixArgs: string[]; shell: boolean; version?: string }> {
    const result = await runCommand(cmdPath, ["--version"], { shell: true, capture: true });
    const version = result.ok ? (result.stdout ?? "").trim().match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0] : undefined;
    return { cmd: cmdPath, prefixArgs: [], shell: true, version };
  }

  private async locateInTree(rootDir: string): Promise<{ cmd: string; prefixArgs: string[]; env?: NodeJS.ProcessEnv; version?: string } | undefined> {
    let bin: string | undefined;
    try {
      const require = createRequire(path.join(rootDir, "noop.js"));
      bin = require.resolve("@deepseek-ai/dsh/lib/bin.js", { paths: [rootDir] });
    } catch {
      /* not present in that tree */
    }
    // npm-installed layout: <root>/node_modules/@deepseek-ai/dsh/lib/bin.js
    if (bin === undefined) {
      const direct = path.join(rootDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
      if (existsSync(direct)) bin = direct;
    }
    if (bin === undefined || !existsSync(bin)) return undefined;
    const node = await resolveNodeExec(this.opts);
    if (node === undefined) {
      this.opts.log("resolve: dsh found, but no node runtime is available to run it");
      return undefined;
    }
    const version = readPackageVersion(path.join(rootDir, "node_modules", "@deepseek-ai", "dsh", "package.json"));
    this.opts.log(`resolve: found dsh v${version ?? "?"} at ${bin} (node: ${node.cmd}${node.electron === true ? " via ELECTRON_RUN_AS_NODE" : ""})`);
    return { cmd: node.cmd, prefixArgs: [bin], env: node.electron === true ? { ELECTRON_RUN_AS_NODE: "1" } : undefined, version };
  }

  private async resolveExplicit(explicit: string): Promise<{ cmd: string; prefixArgs: string[]; shell?: boolean; env?: NodeJS.ProcessEnv } | undefined> {
    // A path to bin.js / an absolute path.
    if (path.isAbsolute(explicit) || explicit.endsWith(".js")) {
      const candidate = path.isAbsolute(explicit) ? explicit : path.resolve(explicit);
      if (!existsSync(candidate)) return undefined;
      const node = await resolveNodeExec(this.opts);
      if (node === undefined) {
        this.opts.log("resolve: no node runtime available to run the CLI");
        return undefined;
      }
      return { cmd: node.cmd, prefixArgs: [candidate], env: node.electron === true ? { ELECTRON_RUN_AS_NODE: "1" } : undefined };
    }
    // Otherwise treat it as a command on PATH.
    const onPath = await findOnPath(explicit);
    if (onPath !== undefined) return { cmd: onPath, prefixArgs: [], shell: true };
    return undefined;
  }

  private async autoInstall(dir: string): Promise<{ cmd: string; prefixArgs: string[] } | undefined> {
    const npm = await findOnPath("npm");
    if (npm === undefined) {
      this.opts.log("auto-install: npm not found on PATH");
      return undefined;
    }
    this.opts.log(`auto-install: installing @deepseek-ai/dsh into ${dir} (one-time, ~200MB)`);
    const result = await runCommand(npm, ["install", "--no-fund", "--no-audit", "--prefix", dir, "@deepseek-ai/dsh"], {
      shell: true,
      log: this.opts.log
    });
    if (!result.ok) {
      this.opts.log("auto-install failed");
      return undefined;
    }
    return this.locateInTree(dir);
  }

  // ---------------------------------------------------------------- dispose

  dispose(): void {
    this.disposed = true;
    this.awaitingExternal = false;
    if (this.watchTimer !== undefined) {
      clearInterval(this.watchTimer);
      this.watchTimer = undefined;
    }
    if (this.healthTimer !== undefined) clearTimeout(this.healthTimer);
    if (this.restartTimer !== undefined) clearTimeout(this.restartTimer);
    if (this.child !== undefined && !this.child.killed) {
      try {
        this.child.kill();
      } catch {
        /* already gone */
      }
    }
    this.child = undefined;
  }
}

// ------------------------------------------------------------------- utils

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read the `version` field of a package.json, or undefined when missing/unreadable. */
function readPackageVersion(pkgJsonPath: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Inject the split-panel adapter into one index.html string.
 * @returns the patched HTML, or undefined when the document already carries
 * the current adapter (or cannot carry one).
 */
export function injectPanelSupport(html: string): string | undefined {
  const next = injectPanelSupportHtml(html);
  return next === null ? undefined : next;
}

/**
 * Patch one dsh-web-frontend dist/index.html on disk (idempotent).
 * @returns true when this call modified the file.
 */
export function patchFrontendIndexFile(file: string, log?: (line: string) => void): boolean {
  try {
    const next = injectPanelSupport(readFileSync(file, "utf8"));
    if (next === undefined) return false;
    writeFileSync(file, next);
    log?.(`panel: patched ${file}`);
    return true;
  } catch (err) {
    log?.(`panel: could not patch ${file}: ${String(err)}`);
    return false;
  }
}

/** Find an executable on PATH (Windows: resolves .cmd/.exe). Returns the command to spawn (shell:true friendly). */
export async function findOnPath(name: string): Promise<string | undefined> {
  const isWin = process.platform === "win32";
  const cmd = isWin ? "where.exe" : "which";
  const result = await runCommand(cmd, [name], { shell: false, capture: true });
  if (!result.ok) return undefined;
  const first = (result.stdout ?? "").split(/\r?\n/)[0]?.trim();
  if (first === undefined || first === "") return undefined;
  return first;
}

/**
 * Resolve a node runtime able to run a JS file.
 *
 * Order: explicit test override → `node` on PATH → the bundled portable
 * node.exe (shipped inside the vsix, same ABI as the bundled native modules,
 * so machines with NO node/npm at all still work) → the extension-host
 * binary itself with ELECTRON_RUN_AS_NODE=1 (last resort; its Electron node
 * ABI may not match bundled native modules like keytar).
 */
async function resolveNodeExec(opts: DshOptions): Promise<{ cmd: string; electron: boolean } | undefined> {
  if (opts.nodeExecOverride !== undefined) {
    return { cmd: opts.nodeExecOverride, electron: opts.electronNode === true };
  }
  const onPath = await findOnPath("node");
  if (onPath !== undefined) return { cmd: onPath, electron: false };
  // Bundled portable node (vsix-shipped), ABI-matched to the bundled deps.
  const bundledNode = path.join(__dirname, "..", "vendor", "node", "node.exe");
  if (existsSync(bundledNode)) return { cmd: bundledNode, electron: false };
  const self = process.execPath;
  const base = path.basename(self).toLowerCase();
  if (base === "node" || base === "node.exe") return { cmd: self, electron: false };
  // Anything else is (almost certainly) the Electron-based extension host:
  // reuse it as Node.
  return { cmd: self, electron: true };
}

async function npmGlobalRoot(): Promise<string | undefined> {
  const npm = await findOnPath("npm");
  if (npm === undefined) return undefined;
  const result = await runCommand(npm, ["root", "-g"], { shell: true, capture: true });
  if (!result.ok) return undefined;
  const root = (result.stdout ?? "").trim();
  return root === "" ? undefined : root;
}

interface RunResult {
  ok: boolean;
  stdout?: string;
}

function runCommand(
  cmd: string,
  args: string[],
  opts: { shell?: boolean; capture?: boolean; log?: (line: string) => void; timeoutMs?: number }
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { shell: opts.shell === true, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: RunResult): void => {
      if (!settled) {
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(result);
      }
    };
    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            opts.log?.(`${cmd} timed out after ${String(opts.timeoutMs)}ms`);
            try {
              child.kill();
            } catch {
              /* already gone */
            }
            finish({ ok: false });
          }, opts.timeoutMs)
        : undefined;
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (opts.capture === true) stdout += text;
      else opts.log?.(text.replace(/\n$/, ""));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (opts.capture === true) stderr += text;
      else opts.log?.(text.replace(/\n$/, ""));
    });
    child.on("error", (err) => {
      opts.log?.(`run error ${cmd}: ${String(err)}`);
      finish({ ok: false });
    });
    child.on("exit", (code) => {
      if (code !== 0 && opts.capture === true) {
        opts.log?.(`${cmd} exited ${String(code)}: ${stderr.trim()}`);
      }
      finish({ ok: code === 0, stdout });
    });
  });
}
