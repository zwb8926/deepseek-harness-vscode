// Adopting an EXTERNAL dsh server whose frontend carries no panel adapter must
// patch it at runtime — otherwise the editor tab silently degrades to the full
// GUI (the sidebar comes back). This is the bug the extension was reported for.
//
// Self-contained: strips the adapter from the repo's bundled frontend, starts a
// RAW server (no DshManager involved, so nothing has patched anything yet), then
// lets a DshManager adopt it and checks the served page.
//
//   node scripts/verify/adopt-unpatched.mjs

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  REPO, forgeCookie, loadWithStubbedVscode, mkTempHome, panelAdapter,
  startDsh, stubVscode, suite, waitFor,
} from "./harness.mjs";

const { PANEL_MARKER, PANEL_INJECT } = panelAdapter();

const s = suite("adopt unpatched frontend");
const INDEX = path.join(REPO, "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist", "index.html");
const CLI = path.join(REPO, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");

if (!existsSync(INDEX)) {
  console.log(`  skip: bundled frontend not found at ${INDEX}`);
  process.exit(0);
}

const home = mkTempHome();
const original = readFileSync(INDEX, "utf8");
function stripAdapter() {
  const html = readFileSync(INDEX, "utf8");
  const at = html.indexOf(`<!-- ${PANEL_MARKER} -->`);
  if (at < 0) return false;
  const scriptAt = html.indexOf("<script>", at);
  const scriptEnd = html.indexOf("</script>", scriptAt);
  writeFileSync(INDEX, html.slice(0, at) + html.slice(scriptEnd + "</script>".length));
  return true;
}

const port = 3310 + Math.floor(Math.random() * 90);
const server = await startDsh({ home, port, cli: CLI });
let manager;
try {
  s.check("stripped the adapter from the bundled frontend", stripAdapter());
  s.check("served page really has no adapter", !readFileSync(INDEX, "utf8").includes(PANEL_MARKER));
  s.check("raw server started (no DshManager involved)", typeof server.url === "string", server.url ?? server.stderr().slice(0, 120));
  await waitFor(() => existsSync(path.join(home, ".credentials.yaml")), { tries: 40, delay: 250 });

  const { DshManager } = loadWithStubbedVscode("out/dshManager.js", stubVscode());
  manager = new DshManager({
    port,
    home,
    autoInstall: false,
    autoRestart: false,
    watchExternal: true,
    cwd: REPO,
    onInfo: () => {},
    log: (l) => console.log("  [dsh]", l),
  });
  await manager.start();
  const info = manager.info;
  s.check("adopted the external server", info.external === true, `state=${info.state}`);
  s.check("reported split-panel support", info.panelSupport === true);
  s.check("adapter is back on disk", readFileSync(INDEX, "utf8").includes(PANEL_INJECT));

  const { cookie } = forgeCookie(`http://127.0.0.1:${port}`, home);
  const res = await fetch(`http://127.0.0.1:${port}/?dshPanel=center`, { headers: { cookie } });
  const body = await res.text();
  s.check("the SERVED page carries the adapter", res.status === 200 && body.includes(PANEL_INJECT), `status=${res.status} bytes=${body.length}`);
} finally {
  if (manager !== undefined) { try { await manager.stop(); } catch {} }
  await server.stop();
  // leave the repo frontend patched (the state the build expects)
  if (!readFileSync(INDEX, "utf8").includes(PANEL_INJECT)) {
    writeFileSync(INDEX, original);
    console.log("  (restored the pre-test frontend)");
  }
  try { rmSync(home, { recursive: true, force: true }); } catch {}
}

process.exit(s.finish() ? 0 : 1);
