// Lifecycle features through the extension's own DshManager against the bundled
// harness: workspace ensure, session create, rename, list (cwd + title
// projection), archive, workspace baseline, theme and the search fallback.
//
// Self-contained: spins up its own server on a throwaway home.
//
//   node scripts/verify/feature-check.mjs

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO, loadWithStubbedVscode, mkTempHome, stubVscode, suite, waitFor } from "./harness.mjs";

const s = suite("feature check");
const home = mkTempHome();
const project = mkdtempSync(path.join(tmpdir(), "dsh-verify-project-"));
mkdirSync(project, { recursive: true });

const { DshManager } = loadWithStubbedVscode("out/dshManager.js", stubVscode());
const manager = new DshManager({
  port: 0,
  home,
  cliPath: path.join(REPO, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
  autoInstall: false,
  autoRestart: false,
  cwd: project,
  onInfo: () => {},
  log: (l) => console.log("  [dsh]", l),
});

try {
  await manager.start();
  s.check("server reaches running", manager.info.state === "running", `state=${manager.info.state}`);
  s.check("split panels supported", manager.info.panelSupport === true);

  const ws = await manager.ensureWorkspace(project);
  s.check("ensureWorkspace", typeof ws === "string" && ws !== "", `workspaceId=${ws}`);

  const sid = await manager.createSessionForWorkspace(ws);
  s.check("createSessionForWorkspace", typeof sid === "string" && sid !== "", `sessionId=${sid}`);

  s.check("renameSession", (await manager.renameSession(sid, "verify 会话")) === true);

  const sessions = await manager.listSessions();
  const mine = (sessions ?? []).find((x) => x.sessionId === sid);
  s.check("listSessions reports cwd", mine?.cwd === project, `cwd=${mine?.cwd}`);
  s.check("listSessions back-fills the title projection", mine?.title === "verify 会话", `title=${mine?.title}`);

  // A turn-less session cannot be forked: a harness rule (identical across
  // 0.1.2-rc.1 / 0.1.5 / 0.1.7), asserted so a behaviour change is noticed.
  const forked = await manager.forkSession(sid);
  s.check("forkSession refuses a turn-less session", forked === undefined, `forked=${forked ?? "refused"}`);

  const searched = await manager.searchSessions("verify");
  s.check("searchSessions returns an array without throwing", Array.isArray(searched), `hits=${(searched ?? []).length}`);

  s.check("archiveSession", (await manager.archiveSession(sid)) === true);
  const after = await manager.listWorkspaces();
  s.check("workspace baseline lists the archived session", (after?.archivedSessionIds ?? []).includes(sid), `archived=${(after?.archivedSessionIds ?? []).length}`);

  s.check("applyTheme via settings.update", (await manager.applyTheme("light")) === true);
  await manager.applyTheme("dark");
} finally {
  await manager.stop();
  try { rmSync(project, { recursive: true, force: true }); } catch {}
  try { rmSync(home, { recursive: true, force: true }); } catch {}
}

process.exit(s.finish() ? 0 : 1);
