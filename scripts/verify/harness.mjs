// Shared helpers for the verification suite in scripts/verify/.
//
// Everything here is deliberately dependency-free (node built-ins only): the
// suites run from a checkout of this repo against the bundled dsh, using the
// extension's own compiled output in out/.
//
// Environment knobs:
//   DSH_HOME            home to read credentials / sessions from (default ~/.dsh)
//   DSH_VERIFY_ORIGIN   live server to test against (default http://127.0.0.1:3080)
//   DSH_VERIFY_CHROME   Chrome/Chromium executable for the browser suites
//   DSH_VERIFY_DIST     served frontend dist dir (only shell-forward needs it)

import { execFileSync, spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import Module from "node:module";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export const REPO = path.resolve(import.meta.dirname, "..", "..");
export const require = createRequire(path.join(REPO, "package.json"));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Load a compiled extension module with a stubbed `vscode` API. Returns the
 * module; the stub records created webview panels. */
export function loadWithStubbedVscode(relative, stub) {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    return request === "vscode" ? stub : originalLoad.call(this, request, parent, isMain);
  };
  try {
    const file = path.join(REPO, relative);
    delete require.cache[require.resolve(file)]; // rebind to THIS stub
    return require(file);
  } finally {
    Module._load = originalLoad;
  }
}

/** Chrome/Chromium executable, or undefined when none can be found. */
export function findChrome() {
  const candidates = [
    process.env.DSH_VERIFY_CHROME?.trim(),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((c) => c !== undefined && c !== "");
  return candidates.find((c) => existsSync(c));
}

/** DSH home holding the session store and browser-session credentials. */
export function dshHome() {
  return process.env.DSH_HOME?.trim() || path.join(homedir(), ".dsh");
}

/** A throwaway DSH_HOME (credentials are created by the first server start). */
export function mkTempHome(prefix = "dsh-verify-home-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** A `vscode` stub that answers any property access with a callable. */
export function stubVscode() {
  const callable = () => new Proxy(function () {}, {
    get: (_t, prop) => (prop === "then" ? undefined : callable()),
    apply: () => callable(),
    construct: () => callable(),
  });
  return callable();
}

/** The adapter marker + script text the frontend carries when patched. */
export function panelAdapter() {
  return require(path.join(REPO, "panel-inject.js"));
}

/** Live server origin: first http(s) argv wins, then the env var, then default. */
export function originArg(fallback = "http://127.0.0.1:3080") {
  const fromArgv = process.argv.slice(2).find((a) => /^https?:\/\//.test(a));
  return fromArgv ?? process.env.DSH_VERIFY_ORIGIN?.trim() ?? fallback;
}

/** `--flag value` (or `--flag=value`) from argv, else undefined. */
export function flagValue(flag) {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq !== undefined) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return undefined;
}

/** The browser-session signing secret from <home>/.credentials.yaml. */
export function sessionSecret(home = dshHome()) {
  const file = path.join(home, ".credentials.yaml");
  if (!existsSync(file)) throw new Error(`no credentials at ${file} — start dsh once with DSH_HOME=${home}`);
  const text = readFileSync(file, "utf8");
  let inSection = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const top = raw.length > 0 && raw[0] !== " " && raw[0] !== "\t" && line.includes(":");
    if (!inSection) {
      if (line.startsWith("client-connection/browser-session:")) inSection = true;
      continue;
    }
    if (top) break;
    if (line.startsWith("secret:")) return line.slice(7).trim();
  }
  throw new Error(`no browser-session secret in ${file}`);
}

const b64u = (buf) => buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

/** A signed `dsh-auth-<authority>` browser cookie for one origin. */
export function forgeCookie(origin, home = dshHome()) {
  const authority = new URL(origin).host;
  const key = Buffer.from(sessionSecret(home).replaceAll("-", "+").replaceAll("_", "/"), "base64");
  const now = Date.now();
  const body = b64u(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 30 * 24 * 3600_000 }), "utf8"));
  const cookie = `dsh-auth-${b64u(createHash("sha256").update(authority).digest())}=v1.${body}.${b64u(createHmac("sha256", key).update(body).digest())}`;
  return { cookie, name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1) };
}

/** POST one typert RPC and return `result` (undefined on transport failure). */
export async function rpc(origin, cookie, method, args) {
  const body = JSON.stringify({ type: "client-request", rpcId: `verify-${method}`, method, payload: { args } });
  const res = await fetch(`${origin}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), cookie },
    body,
  });
  return (await res.json())?.result;
}

/** A child environment like a plain editor host's: no inherited DSH_* profile
 * plumbing and no NODE_OPTIONS. Suites must not depend on the ambient DSH
 * session they happen to be launched from — inheriting DSH_PROFILE_DIR from it
 * is exactly how a "the server cannot write settings" bug hides from a test. */
export function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.toUpperCase().startsWith("DSH") || k === "NODE_OPTIONS") delete env[k];
  }
  return { ...env, ...extra };
}

/** Start the bundled dsh CLI in a child process; resolves an object with the
 * child, the parsed URL and a stop() helper. */
export async function startDsh({ home, port, cli, cwd, timeoutMs = 70_000 }) {
  const child = spawn(process.execPath, [cli, "web", "--host", "127.0.0.1", "--port", String(port), "--no-open"], {
    env: cleanEnv({ DSH_HOME: home }),
    cwd: cwd ?? REPO,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  let url;
  child.stdout.on("data", (d) => {
    out += String(d);
    const m = out.match(/dsh web: (https?:\/\/\S+)/);
    if (m) url = m[1];
  });
  child.stderr.on("data", (d) => { err += String(d); });
  const deadline = Date.now() + timeoutMs;
  while (url === undefined && Date.now() < deadline && child.exitCode === null) await sleep(300);
  return {
    child,
    url,
    stderr: () => err,
    stdout: () => out,
    async stop() {
      try { child.kill(); } catch {}
      await sleep(1200);
    },
  };
}

/** Minimal CDP client over the DevTools websocket. */
export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.errors = [];
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.method === "Runtime.exceptionThrown") this.errors.push(m.params.exceptionDetails.text);
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        this.errors.push("console.error: " + JSON.stringify(m.params.args?.map((a) => a.value ?? a.description)));
      }
      const s = this.pending.get(m.id);
      if (s) { this.pending.delete(m.id); m.error ? s.reject(new Error(JSON.stringify(m.error))) : s.resolve(m.result); }
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }
}

/** Headless Chrome + CDP, plus a scratch profile that is cleaned up on close. */
export async function launchChrome({ width = 1400, height = 900, port } = {}) {
  const exe = findChrome();
  if (exe === undefined) return undefined;
  const cdpPort = port ?? 9400 + Math.floor(Math.random() * 400);
  const profile = mkdtempSync(path.join(tmpdir(), "dsh-verify-chrome-"));
  const chrome = spawn(exe, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`, "about:blank"], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 80 && target === undefined; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      target = list.find((t) => t.type === "page");
    } catch { /* not up yet */ }
    if (target === undefined) await sleep(250);
  }
  if (target === undefined) {
    chrome.kill();
    rmSync(profile, { recursive: true, force: true });
    return undefined;
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  return {
    cdp,
    async close() {
      try { ws.close(); } catch {}
      chrome.kill();
      await sleep(300);
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

/** Poll `fn` until it returns truthy or the budget runs out. */
export async function waitFor(fn, { tries = 60, delay = 500 } = {}) {
  for (let i = 0; i < tries; i++) {
    try { if (await fn()) return true; } catch { /* retry */ }
    await sleep(delay);
  }
  return false;
}

/** The vsix in the repo root (newest first), or undefined. */
export function findVsix() {
  return readdirSync(REPO)
    .filter((f) => f.endsWith(".vsix"))
    .map((f) => path.join(REPO, f))
    .sort((a, b) => b.localeCompare(a))[0];
}

/** Extract files from a vsix (zip) into a temp dir; caller removes it. */
export function extractVsix(vsix, entries = []) {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-verify-vsix-"));
  execFileSync("tar", ["-xf", vsix, "-C", dir, ...entries], { stdio: "ignore" });
  return dir;
}

/** Collect check results and print a suite verdict. */
export function suite(name) {
  const results = [];
  return {
    check(label, ok, detail) {
      results.push({ label, ok: ok === true });
      console.log(`  ${ok === true ? "ok  " : "FAIL"} ${label}${detail !== undefined && detail !== "" ? ` — ${detail}` : ""}`);
    },
    finish() {
      const failed = results.filter((r) => !r.ok);
      console.log(`\n${failed.length === 0 ? `${name}: PASS` : `${name}: FAIL (${failed.length}/${results.length})`}`);
      return failed.length === 0;
    },
    get passed() { return results.every((r) => r.ok); },
  };
}
