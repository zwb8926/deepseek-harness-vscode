/**
 * Headless smoke test for the DshManager pipeline — no VS Code needed.
 *
 *   node out/smoke.js [--cli <path-to-bin.js>] [--home <DSH_HOME>] [--port N]
 *
 * Exercises exactly what the extension does at runtime:
 *   1. resolve the CLI, spawn `dsh web --host 127.0.0.1 --port <port>`,
 *   2. parse the printed URL line (port 0 = OS-assigned),
 *   3. health-check the root document (200 + __DSH_BOOT__),
 *   4. verify the /api wire (trust fence passes, RPC envelope errors),
 *   5. stop the server and confirm the process exits.
 *
 * Exits 0 on success, 1 on any failed assertion.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { DshManager, compareVersions, injectPanelSupport } from "./dshManager";

interface Cli {
  cliPath?: string;
  home?: string;
  port: number;
  electron?: string;
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = { port: 0 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cli" && argv[i + 1] !== undefined) cli.cliPath = argv[++i];
    else if (argv[i] === "--home" && argv[i + 1] !== undefined) cli.home = argv[++i];
    else if (argv[i] === "--port" && argv[i + 1] !== undefined) cli.port = Number(argv[++i]);
    else if (argv[i] === "--electron" && argv[i + 1] !== undefined) cli.electron = argv[++i];
  }
  return cli;
}

function httpJson(method: string, url: string, body?: unknown, cookie?: string): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers.Cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        method,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers,
        timeout: 10_000
      },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

/** Mint the browser-session cookie for a dsh 0.1.2+ token URL (GET /?token=… → 303 + Set-Cookie). */
function mintCookie(url: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      resolve(undefined);
      return;
    }
    const token = u.searchParams.get("token");
    if (token === undefined || token === null || token === "") {
      resolve(undefined);
      return;
    }
    const req = http.request(u.origin + "/?token=" + encodeURIComponent(token), (res) => {
      const sc = res.headers["set-cookie"] as string[] | undefined;
      res.resume();
      res.on("end", () => {
        const cookie = Array.isArray(sc) ? sc[0] : sc;
        resolve(cookie !== undefined && cookie !== "" ? cookie.split(";")[0] : undefined);
      });
    });
    req.setTimeout(8_000, () => {
      req.destroy();
      resolve(undefined);
    });
    req.on("error", () => resolve(undefined));
    req.end();
  });
}

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  }
}

/** Second scenario: a second manager must adopt a running server, not spawn. */
async function scenarioAdopt(cliPath: string | undefined): Promise<void> {
  console.log("— adopt —");
  const homeA = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-smoke-"));
  // Same home on purpose: dsh 0.1.2+ authenticates browsers with a cookie
  // signed by the owner secret in $DSH_HOME/.credentials.yaml, so an adopter
  // must share the home (it forges the cookie; it never sees the launch token).
  const homeB = homeA;
  const first = new DshManager({
    port: 0,
    home: homeA,
    cliPath,
    autoInstall: false,
    autoRestart: false,
    cwd: homeA,
    onInfo: (info) => console.log(`  [stateA] ${JSON.stringify(info)}`),
    log: (line) => console.log(`  [dshA] ${line}`)
  });
  await first.start();
  const url = first.info.url;
  check("scenario A server running", first.info.state === "running" && url !== undefined, `state=${first.info.state}`);
  if (url === undefined) {
    await first.stop();
    return;
  }
  const port = Number(new URL(url).port);

  const second = new DshManager({
    port,
    home: homeB,
    autoInstall: false,
    autoRestart: false,
    cwd: homeB,
    onInfo: (info) => console.log(`  [stateB] ${JSON.stringify(info)}`),
    log: (line) => console.log(`  [dshB] ${line}`)
  });
  await second.start();
  check("second manager adopts the running server", second.info.state === "running" && second.info.external === true, `state=${second.info.state} external=${second.info.external}`);
  check("adopted server supports split panels", second.info.panelSupport === true, `panelSupport=${second.info.panelSupport}`);
  check("adopted server exposes a gui proxy", /^http:\/\/127\.0\.0\.1:\d+\/$/.test(second.info.guiUrl ?? ""), `guiUrl=${second.info.guiUrl ?? "none"}`);

  await second.stop();
  check("stopping the adopter leaves the server alive", first.info.state === "running", `first state=${first.info.state}`);

  await first.stop();
  check("original server stopped cleanly", first.info.state === "stopped", `state=${first.info.state}`);
}

/** Third scenario: run through the ELECTRON_RUN_AS_NODE fallback (no node on PATH). */
async function scenarioElectronNode(cliPath: string | undefined, electron: string): Promise<void> {
  console.log("— electron fallback —");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-smoke-"));
  const manager = new DshManager({
    port: 0,
    home,
    cliPath,
    nodeExecOverride: electron,
    electronNode: true,
    autoInstall: false,
    autoRestart: false,
    cwd: home,
    onInfo: (info) => console.log(`  [state] ${JSON.stringify(info)}`),
    log: (line) => console.log(`  [dsh] ${line}`)
  });
  await manager.start();
  check("electron-node spawn reached running", manager.info.state === "running" && manager.info.url !== undefined, `state=${manager.info.state} detail=${manager.info.detail ?? ""}`);
  await manager.stop();
  check("electron-node server stopped", manager.info.state === "stopped", `state=${manager.info.state}`);
}

/** Fourth scenario: autoUpdate consults the registry; with no newer release the bundled dsh must still run. */
async function scenarioAutoUpdate(cliPath: string | undefined): Promise<void> {
  console.log("— auto-update —");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-smoke-"));
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-autoupd-"));
  const manager = new DshManager({
    port: 0,
    home,
    cliPath,
    autoInstall: false,
    autoUpdate: true,
    preferNewer: true,
    autoInstallDir: installDir,
    autoRestart: false,
    cwd: home,
    onInfo: (info) => console.log(`  [state] ${JSON.stringify(info)}`),
    log: (line) => console.log(`  [dsh] ${line}`)
  });
  await manager.start();
  check("auto-update still reaches running", manager.info.state === "running" && manager.info.url !== undefined, `state=${manager.info.state} detail=${manager.info.detail ?? ""}`);
  await manager.stop();
}

async function main(): Promise<void> {
  console.log("— version comparison —");
  const vChecks: Array<[string, string, number]> = [
    ["0.1.0-rc.7", "0.1.0-rc.8", -1],
    ["0.1.0-rc.8", "0.1.0-rc.7", 1],
    ["0.1.0", "0.1.0-rc.9", 1],
    ["0.2.0", "0.1.99", 1],
    ["1.0.0", "1.0.0", 0],
    ["0.1.0-rc.7", "0.1.0-rc.7", 0],
    ["0.1.0-rc.10", "0.1.0-rc.9", 1]
  ];
  for (const [a, b, want] of vChecks) {
    const got = compareVersions(a, b);
    check(`compareVersions(${a}, ${b}) = ${want}`, got === want || Math.sign(got) === Math.sign(want) || (want === 0 && got === 0), `got ${got}`);
  }

  const cli = parseArgs(process.argv.slice(2));
  const home = cli.home ?? fs.mkdtempSync(path.join(os.tmpdir(), "dsh-smoke-"));
  // The manager spawns the server with cwd = home; ensure it exists even when
  // --home points at a path that has been cleaned up.
  fs.mkdirSync(home, { recursive: true });
  console.log(`smoke: DSH_HOME=${home} port=${cli.port} cli=${cli.cliPath ?? "(auto)"}`);

  const manager = new DshManager({
    port: cli.port,
    home,
    cliPath: cli.cliPath,
    autoInstall: false,
    autoRestart: false,
    cwd: home,
    onInfo: (info) => console.log(`  [state] ${JSON.stringify(info)}`),
    log: (line) => console.log(`  [dsh] ${line}`)
  });

  console.log("— start —");
  await manager.start();

  const url = manager.info.url;
  check("manager reached running state", manager.info.state === "running", `state=${manager.info.state} detail=${manager.info.detail ?? ""}`);
  check("url resolved", url !== undefined, `url=${url ?? "none"}`);
  if (url === undefined) {
    await manager.stop();
    process.exit(1);
  }

  console.log("— split panels —");
  const guiUrl = new URL(url);
  const auth = guiUrl.searchParams.get("token") !== null;
  const base = guiUrl.origin;
  check(
    "frontend supports split panels",
    manager.info.panelSupport === true,
    `panelSupport=${manager.info.panelSupport} browserAuth=${auth}`
  );
  // The webview must embed through the GuiProxy (dsh 0.1.2+): the proxy
  // injects the browser cookie, so the very same pages that a cross-origin
  // iframe would 401 on are now served, query params included.
  const embedBase = (manager.info.guiUrl ?? url).replace(/\/$/, "");
  if (auth) {
    check("gui proxy URL available", manager.info.guiUrl !== undefined, `guiUrl=${manager.info.guiUrl ?? "none"}`);
    const proxyRoot = await httpJson("GET", embedBase + "/");
    check("gui proxy serves the SPA", proxyRoot.status === 200 && proxyRoot.text.includes("__DSH_BOOT__"), `status=${proxyRoot.status}`);
  }
  {
    const side = await httpJson("GET", embedBase + "/?dshPanel=sidebar");
    check("GET /?dshPanel=sidebar → 200", side.status === 200, `status=${side.status}`);
    check("sidebar panel page carries the marker", side.text.includes("dsh-vscode-panel"), "panel marker missing");
    const center = await httpJson("GET", embedBase + "/?dshPanel=center");
    check("GET /?dshPanel=center → 200", center.status === 200, `status=${center.status}`);
    check("center panel page carries the marker", center.text.includes("dsh-vscode-panel"), "panel marker missing");
  }
  const injected = injectPanelSupport("<html><head></head></html>");
  check("injectPanelSupport injects once", injected !== undefined && (injected as string).includes("dsh-vscode-panel"), "inject failed");
  check("injectPanelSupport is idempotent", injectPanelSupport(injected as string) === undefined, "second inject should be skipped");

  console.log("— wire —");
  let cookie: string | undefined;
  if (auth) {
    cookie = await mintCookie(url);
    check("minted browser-session cookie", cookie !== undefined && cookie !== "", `cookie=${cookie === undefined ? "none" : "ok"}`);
  }
  const root = await httpJson("GET", base + "/", undefined, cookie);
  check("GET / → 200", root.status === 200, `status=${root.status}`);
  check("index.html carries __DSH_BOOT__", root.text.includes("__DSH_BOOT__"), "boot manifest missing");
  check("index.html is the DSH SPA", root.text.includes("DeepSeek Harness"));

  // The trust fence must PASS for a loopback Host with no Origin (extension-host style).
  // `llm.providers` was renamed to the typert wire (`session/list`, {args:…}) on
  // browser-session-auth servers; pick the form the server speaks.
  const wireMethod = auth ? "session/list" : "llm.providers";
  const wirePayload = auth ? { args: { _request: {} } } : {};
  const envelope = { type: "client-request", rpcId: "smoke-1", method: wireMethod, payload: wirePayload };
  const rpc = await httpJson("POST", base + "/api/" + wireMethod, envelope, cookie);
  check(`POST /api/${wireMethod} is not 403 (trust fence passed)`, rpc.status !== 403, `status=${rpc.status}`);
  check(`POST /api/${wireMethod} answers an RPC envelope`, rpc.status === 200 && rpc.text.includes("server-response"), `status=${rpc.status} body=${rpc.text.slice(0, 120)}`);
  check(`${wireMethod} succeeds`, rpc.status === 200 && rpc.text.includes('"ok":true'), `body=${rpc.text.slice(0, 200)}`);

  const badBody = await httpJson("POST", base + "/api/" + wireMethod, { not: "an envelope" }, cookie);
  check("malformed envelope → schema error envelope", badBody.status === 200 && badBody.text.includes("invalid client-request message"), `status=${badBody.status} body=${badBody.text.slice(0, 120)}`);

  const unknown = await httpJson("POST", base + "/api/__smoke_nope__", envelope, cookie);
  check("unknown endpoint → 404", unknown.status === 404, `status=${unknown.status}`);

  if (!auth) {
    const created = await httpJson("POST", base + "/api/session.create", {
      type: "client-request",
      rpcId: "smoke-2",
      method: "session.create",
      payload: {}
    }, cookie);
    check("session.create succeeds", created.status === 200 && created.text.includes('"ok":true') && created.text.includes("sessionId"), `status=${created.status} body=${created.text.slice(0, 160)}`);
  }

  const get = await httpJson("GET", base + "/api/" + wireMethod, undefined, cookie);
  check("GET /api/<endpoint> → 404/426 (not 403)", get.status !== 403, `status=${get.status}`);

  console.log("— workspace & theme —");
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-project-"));
  const wsSession = await manager.createSessionInWorkspace(projectDir);
  check("createSessionInWorkspace returns a session", wsSession !== undefined, `sessionId=${wsSession ?? "none"}`);
  if (!auth) {
    const wsList = await httpJson("POST", base + "/api/workspace.list", {
      type: "client-request",
      rpcId: "smoke-ws",
      method: "workspace.list",
      payload: {}
    }, cookie);
    const escapedPath = projectDir.replace(/\\/g, "\\\\");
    check("workspace.list contains the project path", wsList.status === 200 && wsList.text.includes(escapedPath), `status=${wsList.status} body=${wsList.text.slice(0, 300)}`);
  } else {
    // dsh 0.1.2+ has no unary workspace.list: the manager subscribes to the
    // workspace/follow stream for the baseline (workspaces + archive set).
    const baseline = await manager.listWorkspaces();
    check(
      "workspace/follow baseline contains the project path",
      (baseline?.items ?? []).some((w) => w.path === projectDir),
      `items=${JSON.stringify((baseline?.items ?? []).map((w) => w.path))} archived=${JSON.stringify(baseline?.archivedSessionIds ?? null)}`
    );
  }
  const sessions = await manager.listSessions();
  check("session.list reports the project cwd", (sessions ?? []).some((s) => s.cwd === projectDir), `sessions=${JSON.stringify(sessions?.map((s) => ({ id: s.sessionId, cwd: s.cwd })))}`);
  const themeOk = await manager.applyTheme("dark");
  check("settings.update ui-theme works", themeOk === true, `applied=${themeOk}`);

  console.log("— stop —");
  await manager.stop();
  check("stopped state", manager.info.state === "stopped", `state=${manager.info.state}`);

  await scenarioAdopt(cli.cliPath);

  if (cli.electron !== undefined) {
    await scenarioElectronNode(cli.cliPath, cli.electron);
  }

  await scenarioAutoUpdate(cli.cliPath);

  console.log(failures === 0 ? "SMOKE PASSED" : `SMOKE FAILED (${failures} assertion${failures === 1 ? "" : "s"})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke crashed:", err);
  process.exit(1);
});
