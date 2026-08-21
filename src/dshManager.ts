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
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

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
  /** Human-readable detail, usually an error message. */
  detail?: string;
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

export class DshManager {
  private opts: DshOptions;
  private child?: ChildProcess;
  private state: DshState = "idle";
  private url?: string;
  private external = false;
  private detail?: string;
  private disposed = false;
  private stopping = false;
  private autoRestartCount = 0;
  private healthTimer?: NodeJS.Timeout;
  private restartTimer?: NodeJS.Timeout;
  private startedAt = 0;
  private everRan = false;

  constructor(opts: DshOptions) {
    this.opts = opts;
  }

  /** Update spawn-relevant options (applied on the next start). */
  configure(partial: Partial<Pick<DshOptions, "port" | "home" | "cliPath" | "extraArgs" | "cwd" | "autoInstall" | "autoRestart" | "autoInstallDir">>): void {
    Object.assign(this.opts, partial);
  }

  get info(): DshRuntimeInfo {
    return {
      state: this.state,
      url: this.url,
      external: this.external,
      detail: this.detail
    };
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

  /** Create a new dsh session via the running server; returns the sessionId. */
  async createSession(): Promise<string | undefined> {
    const value = (await this.rpc("session.create", {})) as { sessionId?: string } | undefined;
    return value?.sessionId;
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
        this.setState("running");
        return;
      }
      this.opts.log("start: nothing listening there (or not a dsh server); spawning our own");
    }

    // 2. Resolve the CLI.
    this.external = false;
    this.url = undefined;
    this.setState("locating");
    const cli = await this.resolveCli();
    if (cli === undefined) {
      this.setState("error", "dsh CLI not found. Install it (npm i -g @deepseek-ai/dsh) or set dsh.cliPath.");
      return;
    }

    // 3. Spawn `dsh web`.
    this.setState("starting");
    const args = ["web", "--host", "127.0.0.1", "--port", String(this.opts.port), ...(this.opts.extraArgs ?? [])];
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.opts.home !== undefined && this.opts.home !== "") env.DSH_HOME = this.opts.home;
    this.opts.log(`spawn: ${cli.cmd} ${args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);
    if (cli.cwd !== undefined) {
      this.opts.log(`       cwd: ${cli.cwd}`);
      this.opts.log(`       DSH_HOME: ${env.DSH_HOME ?? "(inherit)"}`);
    }

    const child = spawn(cli.cmd, cli.prefixArgs.concat(args), {
      cwd: this.opts.cwd ?? os.homedir(),
      env,
      windowsHide: true,
      shell: cli.shell === true
    });
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

  // ------------------------------------------------------------------ stop

  async stop(): Promise<void> {
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

  private async resolveCli(): Promise<{ cmd: string; prefixArgs: string[]; shell?: boolean; cwd?: string } | undefined> {
    const opts = this.opts;

    // 1. Explicit setting.
    const explicit = opts.cliPath?.trim() ?? "";
    if (explicit !== "") {
      const resolved = await this.resolveExplicit(explicit);
      if (resolved !== undefined) return resolved;
      this.opts.log(`resolve: dsh.cliPath "${explicit}" not usable`);
    }

    // 2. Extension-bundled install (node_modules/@deepseek-ai/dsh next to this code).
    const bundled = await this.locateInTree(path.join(__dirname, ".."));
    if (bundled !== undefined) return bundled;

    // 3. PATH: `dsh` command (shell shim works even without node on PATH).
    const onPath = await findOnPath("dsh");
    if (onPath !== undefined) {
      this.opts.log(`resolve: using dsh from PATH (${onPath})`);
      return { cmd: onPath, prefixArgs: [], shell: true };
    }

    // 4. Global npm install.
    const globalRoot = await npmGlobalRoot();
    if (globalRoot !== undefined) {
      const globalBin = await this.locateInTree(globalRoot);
      if (globalBin !== undefined) return globalBin;
    }

    // 5. Auto-install into the extension storage directory.
    if (opts.autoInstall && opts.autoInstallDir !== undefined) {
      this.setState("installing");
      const installed = await this.autoInstall(opts.autoInstallDir);
      if (installed !== undefined) return installed;
    }

    return undefined;
  }

  private async locateInTree(rootDir: string): Promise<{ cmd: string; prefixArgs: string[] } | undefined> {
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
    const node = await resolveNodeExec();
    if (node === undefined) {
      this.opts.log("resolve: dsh found, but no node executable is available to run it");
      return undefined;
    }
    this.opts.log(`resolve: using dsh at ${bin} (node: ${node})`);
    return { cmd: node, prefixArgs: [bin] };
  }

  private async resolveExplicit(explicit: string): Promise<{ cmd: string; prefixArgs: string[]; shell?: boolean } | undefined> {
    // A path to bin.js / an absolute path.
    if (path.isAbsolute(explicit) || explicit.endsWith(".js")) {
      const candidate = path.isAbsolute(explicit) ? explicit : path.resolve(explicit);
      if (!existsSync(candidate)) return undefined;
      const node = await resolveNodeExec();
      if (node === undefined) {
        this.opts.log("resolve: no node executable available to run the CLI");
        return undefined;
      }
      return { cmd: node, prefixArgs: [candidate] };
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
 * Resolve a node executable able to run a JS file.
 * Prefers `node` on PATH; falls back to process.execPath only when the
 * extension host really runs under node (plain-node contexts such as the
 * smoke test). In the VS Code extension host process.execPath is the Code
 * binary and must never be used.
 */
async function resolveNodeExec(): Promise<string | undefined> {
  const onPath = await findOnPath("node");
  if (onPath !== undefined) return onPath;
  const self = process.execPath;
  const base = path.basename(self).toLowerCase();
  if (base === "node" || base === "node.exe") return self;
  return undefined;
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
  opts: { shell?: boolean; capture?: boolean; log?: (line: string) => void }
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { shell: opts.shell === true, windowsHide: true });
    let stdout = "";
    let stderr = "";
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
      resolve({ ok: false });
    });
    child.on("exit", (code) => {
      if (code !== 0 && opts.capture === true) {
        opts.log?.(`${cmd} exited ${String(code)}: ${stderr.trim()}`);
      }
      resolve({ ok: code === 0, stdout });
    });
  });
}
