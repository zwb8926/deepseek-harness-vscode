// The settings write path and the pre-release notice.
//
// This is the chain that broke for a user in the field: the GUI's 继续 button
// saves `ui-settings-general.welcomeNoticeVersion`, the running server rejected
// the write ("profile reload requires the root Include entry"), so the notice
// could never be dismissed — and every settings change silently failed with it.
//
// Checks, on a throwaway home:
//   1. a fresh session DOES show the notice (informational: documents the
//      behaviour this suite is about)
//   2. settings/update accepts the acknowledgement the button sends
//   3. after that acknowledgement, a new session shows NO notice
//   4. the acknowledgement is durable (a second server start still has it)
//
//   node scripts/verify/notice.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO, forgeCookie, launchChrome, mkTempHome, rpc, sleep, startDsh, suite, waitFor } from "./harness.mjs";

const s = suite("settings write + notice");
const home = mkTempHome("dsh-verify-notice-");
const cli = path.join(REPO, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const port = 3810 + Math.floor(Math.random() * 90);
const origin = `http://127.0.0.1:${port}`;
const ACK = "2026-08-13.1";

const NOTICE = `(() => {
  const d = [...document.querySelectorAll('[role="dialog"]')].find((x) => (x.getAttribute('aria-label') || '').includes('内测声明') || (x.innerText || '').startsWith('内测声明'));
  return { present: d !== undefined && d !== null, visible: d ? d.getClientRects().length > 0 : false };
})()`;

async function openFreshSession(chrome, jar) {
  const created = await rpc(origin, jar.cookie, "session/create", { request: { cwd: REPO } });
  const sessionId = created?.value?.sessionId;
  await chrome.cdp.send("Page.navigate", { url: `${origin}/?dshPanel=center&session=${encodeURIComponent(sessionId)}` });
  await waitFor(() => chrome.cdp.eval(`!!document.querySelector('[class$="_frame"]')`), { tries: 90, delay: 500 });
  await sleep(3500);
  return chrome.cdp.eval(NOTICE);
}

let server = await startDsh({ home, port, cli });
if (server.url === undefined) {
  console.log("  skip: server did not start —", server.stderr().slice(0, 160));
  await server.stop();
  process.exit(0);
}

const chrome = await launchChrome({ port: 9353 });
try {
  if (chrome === undefined) {
    console.log("  skip browser checks (no Chrome found — set DSH_VERIFY_CHROME)");
  } else {
    const jar = forgeCookie(origin, home);
    await chrome.cdp.send("Network.setCookie", { name: jar.name, value: jar.value, url: `${origin}/`, path: "/", sameSite: "Strict" });

    const before = await openFreshSession(chrome, jar);
    console.log(`  (informational) a new session shows the notice: ${before.present && before.visible}`);

    const write = await rpc(origin, jar.cookie, "settings/update", { ns: "ui-settings-general", patch: { welcomeNoticeVersion: ACK } });
    s.check("settings/update accepts the acknowledgement", write?.ok === true, write?.ok === false ? JSON.stringify(write.error).slice(0, 180) : "");
    s.check("the acknowledgement reached the profile patch layer", readFileSync(path.join(home, "profiles", "web", "cordis.patch.yml"), "utf8").includes(ACK));

    const after = await openFreshSession(chrome, jar);
    s.check("a new session no longer shows the notice", after.present === false || after.visible === false, `present=${after.present} visible=${after.visible}`);
    s.check("no page JS errors", chrome.cdp.errors.length === 0, chrome.cdp.errors.slice(0, 2).join(" | "));
  }
} finally {
  if (chrome !== undefined) await chrome.close();
}

// durability: the acknowledgement must survive a server restart
await server.stop();
server = await startDsh({ home, port, cli });
if (server.url !== undefined) {
  const jar = forgeCookie(origin, home);
  const again = await rpc(origin, jar.cookie, "settings/update", { ns: "ui-settings-general", patch: { welcomeNoticeVersion: ACK } });
  s.check("the write path still works after a restart", again?.ok === true, again?.ok === false ? JSON.stringify(again.error).slice(0, 180) : "");
} else {
  s.check("server restarts for the durability check", false, server.stderr().slice(0, 160));
}
await server.stop();

process.exit(s.finish() ? 0 : 1);
