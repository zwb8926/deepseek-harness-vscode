// Runs the verification suite. Every check is a standalone script in this
// directory; this runner just sequences them, streams their output and reports.
//
//   npm run verify                  offline suites (+ live ones when reachable)
//   npm run verify -- --only panels
//   npm run verify -- --offline     skip anything needing a live server
//   npm run verify -- http://127.0.0.1:3080
//
// Suites:
//   offline  panel-tabs         one editor tab, sessions switch in place
//            settings-flow      settings delivery under both webview behaviours
//            shell-check        the shell page runs + iframe-ready handshake
//            adopt-unpatched    adopting an unpatched server patches its frontend
//            feature-check      workspace/session/theme lifecycle through the API
//            package-check      the built vsix: contents + boot from the extracted tree
//   live     panels             the split-panel invariant in both panel modes
//            pin                per-tab session pinning (?session=)
//            titles             cold-store launcher labels (copies $DSH_HOME/sessions)

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { REPO, dshHome, forgeCookie, originArg, rpc } from "./harness.mjs";

const OFFLINE = ["panel-tabs", "settings-flow", "shell-check", "adopt-unpatched", "feature-check", "package-check"];
const LIVE = ["panels", "pin", "titles"];

const argv = process.argv.slice(2);
const offlineOnly = argv.includes("--offline");
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : undefined;
const origin = originArg();

async function liveReachable() {
  try {
    const { cookie } = forgeCookie(origin);
    const list = await rpc(origin, cookie, "session/list", { _request: {} });
    return Array.isArray(list?.value?.items);
  } catch {
    return false;
  }
}

const canRunLive = !offlineOnly && (await liveReachable());
if (!canRunLive && !offlineOnly) {
  console.log(`live suites skipped: no reachable dsh server with credentials at ${origin}`);
  console.log(`  (start dsh, or point DSH_HOME at the home holding .credentials.yaml; sessions come from ${dshHome()})\n`);
}

const plan = [];
for (const name of OFFLINE) plan.push({ name, live: false });
for (const name of LIVE) plan.push({ name, live: true });
const selected = plan.filter((p) => (only === undefined ? !p.live || canRunLive : p.name === only));

if (selected.length === 0) {
  console.log(`nothing to run (--only ${only} matched no suite)`);
  process.exit(1);
}

const results = [];
for (const { name, live } of selected) {
  const file = path.join(import.meta.dirname, `${name}.mjs`);
  if (!existsSync(file)) {
    console.log(`\n=== ${name} ===\n  missing ${file}`);
    results.push({ name, ok: false });
    continue;
  }
  console.log(`\n=== ${name}${live ? " (live)" : ""} ===`);
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...(live ? [origin] : [])], { cwd: REPO, stdio: "inherit" });
    child.on("exit", (c) => resolve(c ?? 1));
  });
  results.push({ name, ok: code === 0 });
}

const failed = results.filter((r) => !r.ok);
console.log("\n================ verify summary ================");
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
console.log(`${failed.length === 0 ? "ALL SUITES PASSED" : `${failed.length} SUITE(S) FAILED`}`);
process.exit(failed.length === 0 ? 0 : 1);
