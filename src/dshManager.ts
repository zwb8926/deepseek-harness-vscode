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
import { createHash, createHmac } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { GuiProxy } from "./guiProxy";

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
  /** True when the dsh server guards the GUI with a browser-session cookie
   * (launch-token exchange at GET /, dsh 0.1.2+). Such a GUI cannot be
   * embedded in a cross-origin webview iframe, so the UI falls back to
   * open-in-browser regardless of panelSupport. */
  browserAuth?: boolean;
  /** Loopback proxy URL for the webview to embed (dsh 0.1.2+ servers only).
   * The proxy injects the browser-session cookie server-side, so the SPA
   * loads normally inside the cross-origin webview. */
  guiUrl?: string;
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
/** Back-fill cooldown per session for the session/follow projection read. */
const TITLE_BACKFILL_COOLDOWN_MS = 60_000;
/** Max sessions whose missing projection is back-filled per list round. */
const TITLE_BACKFILL_PER_ROUND = 3;

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
  private browserAuth = false;
  private authCookie?: string;
  private guiProxy?: GuiProxy;
  /** sessionId → last known title (list projections are not always present;
   * see fetchSessionTitle). */
  private titleCache = new Map<string, string>();
  /** sessionId → last time its missing projection was back-filled. */
  private titleFetchAt = new Map<string, number>();
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
      browserAuth: this.browserAuth,
      guiUrl: this.guiProxy?.url,
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
   * undefined when the server is unreachable. Follows the browser-session
   * cookie flow when the server requires it. */
  private async probe(url: string, timeoutMs = 2_500): Promise<number | undefined> {
    const r = await this.authedGet(url, "/", timeoutMs);
    return r?.status;
  }

  /** One plain HTTP GET (no redirect following). Captures the status, the
   * (small) body, and the session cookie minted by a token exchange. */
  private httpGetOnce(
    target: string,
    headers: http.OutgoingHttpHeaders = {},
    timeoutMs = 4_000
  ): Promise<{ status: number; body: string; setCookie?: string } | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: { status: number; body: string; setCookie?: string } | undefined): void => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      const req = http.get(target, { headers, timeout: timeoutMs }, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
        res.on("end", () => {
          const sc = res.headers["set-cookie"];
          finish({ status: res.statusCode ?? 0, body, setCookie: Array.isArray(sc) ? sc[0] : sc });
        });
      });
      req.on("timeout", () => {
        finish(undefined);
        req.destroy();
      });
      req.on("error", () => finish(undefined));
    });
  }

  /** GET one path on the GUI origin, transparently following the dsh
   * browser-session auth flow when the server uses it (dsh 0.1.2+):
   * `GET /?token=…` mints an authority-bound cookie; the request is then
   * repeated with it. Older servers answer the bare root directly. */
  private async authedGet(url: string, pathQuery = "/", timeoutMs = 4_000): Promise<{ status: number; body: string } | undefined> {
    let u: URL | undefined;
    try {
      u = new URL(url);
    } catch {
      return undefined;
    }
    const plain = await this.httpGetOnce(u.origin + pathQuery, {}, timeoutMs);
    if (plain !== undefined && plain.status === 200) return { status: plain.status, body: plain.body };
    if (plain === undefined) return undefined;
    const cookie = await this.ensureAuthCookie(u);
    if (cookie === undefined) return undefined;
    const authed = await this.httpGetOnce(u.origin + pathQuery, { Cookie: cookie }, timeoutMs);
    if (authed !== undefined && authed.status === 200) return { status: authed.status, body: authed.body };
    if (authed !== undefined && authed.status === 401) {
      // Stale cookie — mint once more and retry.
      this.authCookie = undefined;
      const fresh = await this.ensureAuthCookie(u);
      if (fresh === undefined) return undefined;
      const retried = await this.httpGetOnce(u.origin + pathQuery, { Cookie: fresh }, timeoutMs);
      return retried === undefined ? undefined : { status: retried.status, body: retried.body };
    }
    return authed === undefined ? undefined : { status: authed.status, body: authed.body };
  }

  /** Whether the URL answers with the dsh SPA (contains the boot manifest). */
  private async isDshServer(url: string): Promise<boolean> {
    const r = await this.authedGet(url, "/");
    return r !== undefined && r.status === 200 && r.body.includes("__DSH_BOOT__");
  }

  // ----------------------------------------------------------- browser auth

  /** True when the dsh server guards the GUI with the browser-session cookie
   * flow rather than serving the root directly. */
  private async detectBrowserAuth(url: string): Promise<boolean> {
    let u: URL | undefined;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (u.searchParams.get("token") !== null) return true;
    const plain = await this.httpGetOnce(u.origin + "/");
    return plain !== undefined && (plain.status === 401 || plain.status === 303);
  }

  /** Exchange the process launch token (?token= in the printed URL) for the
   * browser-session cookie; undefined when there is no token flow. */
  private async mintAuthCookie(u: URL): Promise<string | undefined> {
    const token = u.searchParams.get("token");
    if (token === undefined || token === null || token === "") return undefined;
    const res = await this.httpGetOnce(`${u.origin}/?token=${encodeURIComponent(token)}`);
    const cookie = res?.setCookie?.split(";")[0]?.trim();
    return cookie !== undefined && cookie !== "" ? cookie : undefined;
  }

  /**
   * Forge a browser-session cookie from `$DSH_HOME/.credentials.yaml`.
   *
   * Adopted servers (e.g. an `npx dsh web` already running on the port) share
   * the DSH_HOME — and therefore the owner-scoped signing secret — but never
   * reveal their launch token. The dsh-client-connection cookie format is
   * `v1.<base64url(json payload)>.<base64url(hmac-sha256(secret, body))>` with
   * the name `dsh-auth-<base64url(sha256(authority))>`; we mirror it so every
   * RPC and health check authenticates without the token.
   */
  private async forgeAuthCookie(u: URL): Promise<string | undefined> {
    const secret = await this.readBrowserSessionSecret();
    if (secret === undefined) return undefined;
    const key = Buffer.from(secret.replaceAll("-", "+").replaceAll("_", "/"), "base64");
    if (key.byteLength !== 32) return undefined;
    const b64u = (buf: Buffer): string => buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const authority = u.host;
    const name = "dsh-auth-" + b64u(createHash("sha256").update(authority).digest());
    const issuedAt = Date.now();
    const expiresAt = issuedAt + 30 * 24 * 3600_000;
    const body = b64u(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), "utf8"));
    const sig = b64u(createHmac("sha256", key).update(body).digest());
    return `${name}=v1.${body}.${sig}`;
  }

  /** The owner-scoped browser-session secret from the DSH_HOME credentials
   * store (best effort — the file format is tiny and stable). */
  private readBrowserSessionSecret(): string | undefined {
    const envHome = process.env.DSH_HOME?.trim();
    const home =
      this.opts.home !== undefined && this.opts.home.trim() !== ""
        ? this.opts.home
        : envHome !== undefined && envHome !== ""
          ? envHome
          : path.join(os.homedir(), ".dsh");
    const file = path.join(home, ".credentials.yaml");
    let text: string | undefined;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
    let inSection = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      const topLevel = raw.length > 0 && raw[0] !== " " && raw[0] !== "\t" && line.includes(":");
      if (!inSection) {
        if (line.startsWith("client-connection/browser-session:")) inSection = true;
        continue;
      }
      if (topLevel) return undefined; // left the record subtree
      if (line.startsWith("secret:")) return line.slice("secret:".length).trim();
    }
    return undefined;
  }

  /** Get a browser-session cookie for one server: prefer the launch-token
   * exchange (own process), fall back to forging from the credentials record
   * (adopted server on the same DSH_HOME). */
  private async ensureAuthCookie(u: URL): Promise<string | undefined> {
    if (this.authCookie !== undefined) return this.authCookie;
    const cookie = (await this.mintAuthCookie(u)) ?? (await this.forgeAuthCookie(u));
    if (cookie !== undefined) this.authCookie = cookie;
    return cookie;
  }

  // -------------------------------------------------------------- GUI proxy

  /** Parse the current GUI URL, or undefined. */
  private parsedUrl(): URL | undefined {
    try {
      return this.url === undefined ? undefined : new URL(this.url);
    } catch {
      return undefined;
    }
  }

  /**
   * Start the webview-friendly loopback proxy for a browser-session-auth
   * server. The SameSite=Strict cookie cannot pass through a cross-origin
   * webview iframe, but the proxy (extension host side) injects it into every
   * forwarded request, so the embedded SPA authenticates as a normal browser.
   */
  private async startGuiProxy(): Promise<void> {
    void this.guiProxy?.stop();
    this.guiProxy = undefined;
    const u = this.parsedUrl();
    if (u === undefined) return;
    const port = Number(u.port);
    if (!Number.isFinite(port) || port === 0) return;
    // The cookie is re-resolved per request: an expired/missing session gets
    // re-minted (or re-forged) without a proxy restart.
    const proxy = new GuiProxy(port, () => this.ensureAuthCookie(this.parsedUrl() ?? u));
    try {
      await proxy.start();
      this.guiProxy = proxy;
      this.opts.log(`gui proxy: webview URL ${proxy.url}`);
    } catch (err) {
      this.opts.log(`gui proxy: failed to start (${String(err)}) — webview falls back to open-in-browser`);
    }
  }

  private stopGuiProxy(): void {
    const proxy = this.guiProxy;
    this.guiProxy = undefined;
    if (proxy !== undefined) void proxy.stop();
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
      const probe = "/?dshPanel=sidebar";
      const body = await this.authedGet(url, probe);
      if (body !== undefined && body.status === 200 && body.body.includes(PANEL_MARKER)) {
        if (!body.body.includes(PANEL_INJECT)) {
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
        const again = await this.authedGet(url, probe);
        if (again !== undefined && again.status === 200 && again.body.includes(PANEL_MARKER)) {
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

  /**
   * Translate one internal RPC call to the server's actual wire form.
   *
   * Pre-0.1.2 servers speak dotted endpoints with a raw field payload
   * (`session.create` + `{cwd}`). dsh 0.1.2+ (browser-session auth servers,
   * detected via `browserAuth`) moved to typert's `namespace/method`
   * endpoints and a `{args: {...}}` envelope with descriptor-named wires
   * (`session/create` + `{request: {cwd}}`). One notable casualty: the
   * workspace LIST is no longer a unary RPC (it rides the `workspace/follow`
   * stream), so callers of `workspace.list` must degrade.
   */
  private rpcRequest(method: string, payload: unknown): { endpoint: string; args: Record<string, unknown>; unsupported?: boolean } | undefined {
    if (!this.browserAuth) return { endpoint: method, args: (payload ?? {}) as Record<string, unknown> };
    const dotAt = method.indexOf(".");
    if (dotAt === -1) return { endpoint: method, args: (payload ?? {}) as Record<string, unknown> };
    const endpoint = method.slice(0, dotAt) + "/" + method.slice(dotAt + 1);
    if (endpoint === "workspace/list") return { endpoint, args: {}, unsupported: true };
    const fields = (payload ?? {}) as Record<string, unknown>;
    switch (endpoint) {
      // Listers and settings carried their wire names across; everything else
      // now expects a single `request` field.
      case "session/list":
        return { endpoint, args: { _request: {} } };
      case "session/search":
      case "session/create":
      case "session/rename":
      case "session/fork":
      case "workspace/create":
      case "workspace/rename":
      case "workspace/delete":
      case "workspace/archiveSession":
        return { endpoint, args: { request: fields } };
      default:
        return { endpoint, args: fields };
    }
  }

  /** POST one /api RPC envelope; returns the parsed response value or undefined. */
  private async rpc(method: string, payload: unknown): Promise<unknown | undefined> {
    if (this.url === undefined || this.state !== "running") return undefined;
    let u: URL;
    try {
      u = new URL(this.url);
    } catch {
      return undefined;
    }
    const wire = this.rpcRequest(method, payload);
    if (wire === undefined) return undefined;
    if (wire.unsupported === true) {
      this.opts.log(`rpc ${method}: not available on this dsh wire version`);
      return undefined;
    }
    const envelope = {
      type: "client-request",
      rpcId: `dsh-vsc-${Date.now()}`,
      method: wire.endpoint,
      // typert wire (0.1.2+): payload = {args: <descriptor fields>}; older
      // servers take the raw field object.
      payload: this.browserAuth ? { args: wire.args } : wire.args
    };
    const body = JSON.stringify(envelope);
    // Browser-session auth (dsh 0.1.2+): every /api call needs the cookie.
    const cookie = await this.ensureAuthCookie(u);
    const headers: http.OutgoingHttpHeaders = {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body)
    };
    if (cookie !== undefined) headers.Cookie = cookie;
    return new Promise((resolve) => {
      const req = http.request(
        new URL(`${u.origin}/api/${wire.endpoint}`),
        {
          method: "POST",
          headers,
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
                this.opts.log(`rpc ${wire.endpoint} failed: ${parsed.result?.error?.message ?? text.slice(0, 200)}`);
                resolve(undefined);
              }
            } catch {
              resolve(undefined);
            }
          });
        }
      );
      req.on("timeout", () => {
        this.opts.log(`rpc ${wire.endpoint} timed out`);
        req.destroy();
        resolve(undefined);
      });
      req.on("error", (err) => {
        this.opts.log(`rpc ${wire.endpoint} error: ${String(err)}`);
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

  /** Create a session directly inside an existing workspace record. */
  async createSessionForWorkspace(workspaceId: string): Promise<string | undefined> {
    const value = (await this.rpc("session.create", { workspaceId })) as { sessionId?: string } | undefined;
    if (value?.sessionId === undefined) {
      this.opts.log(`createSessionForWorkspace: could not create session in ${workspaceId}`);
    }
    return value?.sessionId;
  }

  /** Rename a session (sets its durable title). Returns whether the RPC succeeded. */
  async renameSession(sessionId: string, title: string): Promise<boolean> {
    const value = (await this.rpc("session.rename", { sessionId, title })) as { title?: string } | undefined;
    if (value === undefined) {
      this.opts.log(`renameSession: could not rename ${sessionId}`);
      return false;
    }
    this.opts.log(`renameSession: ${sessionId} -> ${title}`);
    return true;
  }

  /** Fork a session at its current tail (the child carries the history).
   * Returns the child sessionId, or undefined on failure (e.g. blank session). */
  async forkSession(sessionId: string): Promise<string | undefined> {
    const value = (await this.rpc("session.fork", { sessionId })) as { sessionId?: string } | undefined;
    if (value?.sessionId === undefined) {
      this.opts.log(`forkSession: could not fork ${sessionId}`);
    }
    return value?.sessionId;
  }

  /** Archive a session into the registry-global archive set (hidden from the
   * launcher/workspace lists, exactly like the dsh GUI sidebar). */
  async archiveSession(sessionId: string): Promise<boolean> {
    const value = (await this.rpc("workspace.archiveSession", { sessionId })) as
      | { archivedSessionIds?: string[] }
      | undefined;
    if (value === undefined) {
      this.opts.log(`archiveSession: could not archive ${sessionId}`);
      return false;
    }
    this.opts.log(`archiveSession: ${sessionId} archived (${value.archivedSessionIds?.length ?? 0} total)`);
    return true;
  }

  /** Rename a workspace record (display title). */
  async renameWorkspace(workspaceId: string, title: string): Promise<boolean> {
    const value = (await this.rpc("workspace.rename", { workspaceId, title })) as { workspace?: unknown } | undefined;
    if (value === undefined) {
      this.opts.log(`renameWorkspace: could not rename ${workspaceId}`);
      return false;
    }
    this.opts.log(`renameWorkspace: ${workspaceId} -> ${title}`);
    return true;
  }

  /** Delete a workspace registration (sessions/records are kept; they become ungrouped). */
  async deleteWorkspace(workspaceId: string): Promise<boolean> {
    const value = (await this.rpc("workspace.delete", { workspaceId })) as { deleted?: boolean } | undefined;
    if (value?.deleted !== true) {
      this.opts.log(`deleteWorkspace: could not delete ${workspaceId}`);
      return false;
    }
    this.opts.log(`deleteWorkspace: ${workspaceId} deleted`);
    return true;
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

  /** List the real workspace records (verification/diagnostics).
   * Also returns the registry-global archive set (the same `archivedSessionIds`
   * the GUI sidebar uses to hide archived sessions: a session bound to a
   * workspace is only visible when it is not in this set). */
  async listWorkspaces(): Promise<
    | {
        items: Array<{ workspaceId: string; path: string; title: string; sessionIds: string[] }>;
        archivedSessionIds: string[];
      }
    | undefined
  > {
    const value = (await this.rpc("workspace.list", {})) as
      | {
          items?: Array<{ workspaceId: string; path: string; title: string; sessionIds: string[] }>;
          archivedSessionIds?: string[];
        }
      | undefined;
    if (value !== undefined) {
      return {
        items: value.items ?? [],
        archivedSessionIds: value.archivedSessionIds ?? []
      };
    }
    // dsh 0.1.2+ dropped the unary workspace LIST; the real state (workspaces
    // plus the archive set) rides the `workspace/follow` stream. Subscribe
    // once and take the baseline frame.
    if (this.browserAuth) {
      const snapshot = await this.workspaceBaseline();
      if (snapshot !== undefined) {
        this.opts.log(`listWorkspaces: workspace/follow snapshot — ${snapshot.items.length} workspace(s), ${snapshot.archivedSessionIds.length} archived`);
        return snapshot;
      }
    }
    return undefined;
  }

  /**
   * One-shot subscription to the dsh 0.1.2+ `workspace/follow` stream.
   * Returns the baseline frame (workspaces + archive set), or undefined.
   */
  private async workspaceBaseline(): Promise<
    | {
        items: Array<{ workspaceId: string; path: string; title: string; sessionIds: string[] }>;
        archivedSessionIds: string[];
      }
    | undefined
  > {
    const u = this.parsedUrl();
    if (u === undefined) return undefined;
    const cookie = await this.ensureAuthCookie(u);
    if (cookie === undefined) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const WebSocket: any = require("ws");
    return await new Promise((resolve) => {
      let settled = false;
      let ws: any;
      const finish = (value: { items: Array<{ workspaceId: string; path: string; title: string; sessionIds: string[] }>; archivedSessionIds: string[] } | undefined): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws?.close();
        } catch {
          /* already closed */
        }
        resolve(value);
      };
      const timer = setTimeout(() => finish(undefined), 10_000);
      try {
        ws = new WebSocket(`ws://${u.host}/api/remote.mux`, { headers: { Cookie: cookie } });
      } catch {
        finish(undefined);
        return;
      }
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "open", streamId: `dsh-vsc-${Date.now()}`, endpoint: "workspace/follow", payload: { args: {} } }));
      });
      ws.on("message", (data: unknown) => {
        let msg: any;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        if (msg?.type === "item" && msg.value?.type === "baseline" && msg.value.value !== undefined) {
          const value = msg.value.value;
          const items = Array.isArray(value.items)
            ? value.items
                .filter((w: any) => typeof w?.workspaceId === "string")
                .map((w: any) => ({
                  workspaceId: String(w.workspaceId),
                  path: typeof w.path === "string" ? w.path : "",
                  title: typeof w.title === "string" ? w.title : "",
                  sessionIds: Array.isArray(w.sessionIds) ? w.sessionIds.map(String) : []
                }))
            : [];
          finish({
            items,
            archivedSessionIds: Array.isArray(value.archivedSessionIds) ? value.archivedSessionIds.map(String) : []
          });
        } else if (msg?.type === "end" || msg?.type === "error") {
          finish(undefined);
        }
      });
      ws.on("error", () => finish(undefined));
      ws.on("close", () => finish(undefined));
    });
  }

  /** List all sessions with their cwd and updatedAt (to find a project's session).
   * Also surfaces the dsh title/stats projection best-effort so the native
   * launcher tree can show human-readable titles without a second round trip. */
  async listSessions(): Promise<
    Array<{
      sessionId: string;
      updatedAt: number;
      cwd?: string;
      running?: boolean;
      blank?: boolean;
      title?: string;
      turns?: number;
      steps?: number;
    }> | undefined
  > {
    const value = (await this.rpc("session.list", {})) as
      | {
          items?: Array<{
            sessionId: string;
            updatedAt: number;
            cwd?: string;
            running?: boolean;
            blank?: boolean;
            projections?: { values?: { title?: string; sessionStats?: { turns?: number; steps?: number } } };
          }>;
        }
      | undefined;
    // On dsh 0.1.2+ the session title lives in the (cached) projections. A few
    // migrated/legacy sessions occasionally lack them on list; those are
    // back-filled via a one-shot session/follow read (which also completes the
    // server-side projection), so the launcher shows real titles.
    const missing: string[] = [];
    const sessions = (value?.items ?? []).map((it) => {
      let title = it.projections?.values?.title;
      if (title !== undefined && title !== "") {
        this.titleCache.set(it.sessionId, title);
      } else {
        title = this.titleCache.get(it.sessionId);
        if (title === undefined) missing.push(it.sessionId);
      }
      return {
        sessionId: it.sessionId,
        updatedAt: it.updatedAt,
        cwd: it.cwd,
        running: it.running,
        blank: it.blank,
        title,
        turns: it.projections?.values?.sessionStats?.turns,
        steps: it.projections?.values?.sessionStats?.steps
      };
    });
    if (this.browserAuth && missing.length > 0) void this.backfillSessionTitles(missing);
    return sessions;
  }

  /**
   * Lazily complete the missing session projections (titles) for a few
   * sessions per round: subscribing to the alpha.2 `session/follow` stream
   * returns a snapshot whose `projections.values.title` is the durable title
   * and also makes the server back-fill the projection, so the next plain
   * `session.list` carries it too.
   */
  private async backfillSessionTitles(ids: string[]): Promise<void> {
    const now = Date.now();
    const todo = ids
      .filter((id) => now - (this.titleFetchAt.get(id) ?? 0) >= TITLE_BACKFILL_COOLDOWN_MS)
      .slice(0, TITLE_BACKFILL_PER_ROUND);
    if (todo.length === 0) return;
    await Promise.all(
      todo.map(async (id) => {
        this.titleFetchAt.set(id, now);
        const title = await this.fetchSessionTitle(id);
        if (title !== undefined && title !== "") {
          this.titleCache.set(id, title);
          this.opts.log(`session title back-fill: ${id.slice(0, 24)}… → "${title}"`);
        }
      })
    );
  }

  /** Read one session's snapshot projections over the mux stream. */
  private async fetchSessionTitle(sessionId: string): Promise<string | undefined> {
    const u = this.parsedUrl();
    if (u === undefined) return undefined;
    const cookie = await this.ensureAuthCookie(u);
    if (cookie === undefined) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const WebSocket: any = require("ws");
    return await new Promise((resolve) => {
      let settled = false;
      let ws: any;
      const finish = (value: string | undefined): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws?.close();
        } catch {
          /* already closed */
        }
        resolve(value);
      };
      const timer = setTimeout(() => finish(undefined), 8_000);
      try {
        ws = new WebSocket(`ws://${u.host}/api/remote.mux`, { headers: { Cookie: cookie } });
      } catch {
        finish(undefined);
        return;
      }
      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            type: "open",
            streamId: `dsh-title-${Date.now()}`,
            endpoint: "session/follow",
            payload: { args: { request: { address: { kind: "session", sessionId } } } }
          })
        );
      });
      ws.on("message", (data: unknown) => {
        let msg: any;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        if (msg?.type === "item" && msg.value?.type === "snapshot" && msg.value.projections?.values !== undefined) {
          const title = msg.value.projections.values.title;
          finish(typeof title === "string" && title !== "" ? title : undefined);
        } else if (msg?.type === "error" || msg?.type === "end") {
          finish(undefined);
        }
      });
      ws.on("error", () => finish(undefined));
      ws.on("close", () => finish(undefined));
    });
  }

  /** Search sessions (launcher search box). Tries the harness content search;
   * when the deployment disables the session-query index (openAt "never"), it
   * falls back to local title/cwd substring matching over session.list. */
  async searchSessions(query: string): Promise<Array<{ sessionId: string; title: string; cwd?: string; running?: boolean }> | undefined> {
    const q = query.trim();
    if (q === "") return [];
    const lower = q.toLowerCase();
    try {
      const remote = (await this.rpc("session.search", { query: q })) as
        | { items?: Array<{ sessionId?: string; title?: string; workspace?: string; running?: boolean }> }
        | undefined;
      if (remote !== undefined && Array.isArray(remote.items)) {
        return remote.items
          .filter((it): it is { sessionId: string; title?: string; running?: boolean } => typeof it.sessionId === "string")
          .slice(0, 30)
          .map((it) => ({
            sessionId: it.sessionId,
            title: it.title != null && it.title !== "" ? it.title : "未命名会话",
            running: it.running
          }));
      }
    } catch {
      /* fall through to local matching */
    }
    const sessions = await this.listSessions();
    return (sessions ?? [])
      .filter(
        (s) =>
          !s.blank &&
          ((s.title ?? "").toLowerCase().includes(lower) || (s.cwd ?? "").toLowerCase().includes(lower))
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 30)
      .map((s) => ({
        sessionId: s.sessionId,
        title: s.title != null && s.title !== "" ? s.title : "未命名会话",
        cwd: s.cwd,
        running: s.running
      }));
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
        this.browserAuth = await this.detectBrowserAuth(candidate);
        this.authCookie = undefined;
        this.everRan = true;
        this.awaitingExternal = false;
        this.autoRestartCount = 0;
        if (this.browserAuth) await this.startGuiProxy();
        this.panelSupport = await this.ensurePanelSupport(candidate);
        this.setState("running");
        return;
      }
      this.opts.log("start: nothing listening there (or not a dsh server); spawning our own");
    }

    // 2. Resolve the CLI.
    // Preserve awaitingExternal here: if the spawn path below fails (port
    // TIME_WAIT, EADDRINUSE, missing module, …) the watch must keep
    // re-probing the configured port, otherwise a recovered external
    // server (or a port that becomes free later) would never be picked up
    // again. The flag is cleared only when the spawn actually succeeds
    // (see below, after the child is bound to the URL).
    this.external = false;
    this.url = undefined;
    this.panelSupport = undefined;
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
        // dsh 0.1.2+ prints a ?token= launch URL and guards the GUI with a
        // browser-session cookie (the token is exchanged at GET / for a
        // SameSite=Strict cookie, so a cross-origin webview cannot embed it).
        this.browserAuth = /[?&]token=/.test(m[1]);
        this.authCookie = undefined;
        this.opts.log(`resolved GUI URL: ${this.url}${this.browserAuth ? " (browser-session auth)" : ""}`);
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
    // The spawn path is now bound to a live, owned child — clear the
    // watch's "look for an external server on the configured port" hint so
    // a future re-probe doesn't re-adopt the very server we just started.
    this.awaitingExternal = false;
    this.setState("starting");

    // Health check: the root must answer 200 with the SPA.
    const healthDeadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (!this.disposed && this.child === child) {
      const status = await this.probe(url);
      if (status === 200) {
        const ok = await this.isDshServer(url);
        if (ok) {
          this.autoRestartCount = 0;
          if (this.browserAuth) await this.startGuiProxy();
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
    this.stopGuiProxy();
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
      } else if (this.state === "stopped" && this.child === undefined && (this.autoRestartCount ?? 0) < MAX_AUTO_RESTARTS) {
        // No external server is answering on the configured port and the
        // auto-restart budget is not yet exhausted: kick a fresh start() so
        // the manager tries to spawn its own dsh. Without this, a manager
        // that burned its scheduleRestart budget on EADDRINUSE / module-load
        // failures would stay "stopped" forever even after the port freed
        // up; here we keep the recovery loop alive on every watch tick
        // (5s) until either a spawn succeeds or an external server returns.
        this.opts.log(`watch: no external dsh on ${candidate} — re-attempting start()`);
        this.autoRestartCount += 1;
        void this.start().catch((err) => this.opts.log(`watch: start retry failed: ${String(err)}`));
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
    this.stopGuiProxy();
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
    this.stopGuiProxy();
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
