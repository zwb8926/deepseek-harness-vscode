// Cold-store launcher labels: after an upgrade every session projection is cold
// (no title, no turn count, blank=false), and the launcher used to paint the
// whole list with 未命名会话. The rules are taken from the GENERATED webview
// script — the code that actually ships — and applied to a throwaway copy of the
// session store read by a fresh server.
//
//   node scripts/verify/titles.mjs            (copies $DSH_HOME/sessions)
//   DSH_HOME=/path/to/home node scripts/verify/titles.mjs

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  REPO, dshHome, forgeCookie, loadWithStubbedVscode, mkTempHome, panelAdapter,
  rpc, sleep, startDsh, stubVscode, suite,
} from "./harness.mjs";

const s = suite("session titles");
const sourceHome = dshHome();
const sessionsDir = path.join(sourceHome, "sessions");
if (!existsSync(sessionsDir) || readdirSync(sessionsDir).length === 0) {
  console.log(`  skip: no session store at ${sessionsDir}`);
  process.exit(0);
}

const home = mkTempHome("dsh-verify-titles-");
mkdirSync(path.join(home, "sessions"), { recursive: true });
cpSync(sessionsDir, path.join(home, "sessions"), { recursive: true });
const count = readdirSync(path.join(home, "sessions")).flatMap((g) => readdirSync(path.join(home, "sessions", g))).length;
console.log(`  cold copy of ${count} sessions -> ${home}`);

// the SHIPPED label rules, extracted from the generated webview script
const callableVscode = stubVscode();
const { buildLauncherHtml } = loadWithStubbedVscode("out/launcherView.js", callableVscode);
const html = buildLauncherHtml();
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
const fnSrc = script.slice(script.indexOf("function sessionLabel"), script.indexOf("function sessionRowHtml"));
const { sessionLabel, isListable } = new Function(`${fnSrc}; return { sessionLabel, isListable };`)();
const oldLabel = (x) => (x.title != null && x.title !== "" ? x.title : x.blank ? "新会话" : "未命名会话");

const port = 3410 + Math.floor(Math.random() * 90);
const server = await startDsh({ home, port, cli: path.join(REPO, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js") });
try {
  s.check("server started on the cold copy", typeof server.url === "string", server.url ?? server.stderr().slice(0, 120));
  const { cookie } = forgeCookie(`http://127.0.0.1:${port}`, home);
  const origin = `http://127.0.0.1:${port}`;
  const rows = async () => (await rpc(origin, cookie, "session/list", { _request: {} }))?.value?.items ?? [];

  const cold = await rows();
  const coldRows = cold.map((it) => ({
    sessionId: it.sessionId,
    title: it?.projections?.values?.title ?? null,
    blank: it.blank,
    turns: it?.projections?.values?.sessionStats?.turns,
  }));
  const coldCount = coldRows.filter((x) => x.turns === undefined).length;
  s.check("cold copy really is cold (no turn projections)", coldCount > 0, `cold=${coldCount}/${coldRows.length}`);
  s.check(
    "old rule would have painted the list with 未命名会话",
    coldRows.filter(isListable).filter((x) => oldLabel(x) === "未命名会话").length > 0,
    `old=${coldRows.filter(isListable).filter((x) => oldLabel(x) === "未命名会话").length}`
  );
  s.check(
    "shipped rule labels none of them 未命名会话",
    coldRows.filter(isListable).filter((x) => sessionLabel(x) === "未命名会话").length === 0,
    `new=${coldRows.filter(isListable).filter((x) => sessionLabel(x) === "未命名会话").length}`
  );

  // warm the projections the way the extension's back-fill does, then re-check
  const { DshManager } = loadWithStubbedVscode("out/dshManager.js", callableVscode);
  const manager = new DshManager({
    port,
    home,
    autoInstall: false,
    autoRestart: false,
    watchExternal: true,
    cwd: REPO,
    onInfo: () => {},
    log: () => {},
  });
  try {
    await manager.start();
    let latest = [];
    for (let i = 0; i < 5; i++) {
      latest = (await manager.listSessions()) ?? [];
      await sleep(2000);
    }
    const stillCold = latest.filter((x) => x.turns === undefined).length;
    const titled = latest.filter((x) => x.title != null && x.title !== "").length;
    s.check("back-fill warms the projections", stillCold < coldCount, `cold ${coldCount} -> ${stillCold}`);
    s.check("titles come back for sessions that have prompts", titled > 0, `titled=${titled}`);
    s.check(
      "no row renders 未命名会话 after warming either",
      latest.filter(isListable).filter((x) => sessionLabel(x) === "未命名会话").length === 0,
      `new=${latest.filter(isListable).filter((x) => sessionLabel(x) === "未命名会话").length}`
    );
  } finally {
    await manager.stop();
  }
} finally {
  await server.stop();
  try { rmSync(home, { recursive: true, force: true }); } catch {}
}

process.exit(s.finish() ? 0 : 1);
