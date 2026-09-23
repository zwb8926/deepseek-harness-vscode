// Per-editor-tab session pinning: `?dshPanel=center&session=<id>` must write
// `dsh.sessions.current = {sessionId}` BEFORE the app boots, and the app must
// come up on that conversation (document.title follows the session title).
// The snapshot store moved packages in 0.1.7, so this guards "each tab shows its
// own conversation" against that kind of internal reshuffle.
//
//   node scripts/verify/pin.mjs [origin]

import { forgeCookie, launchChrome, originArg, rpc, sleep, suite, waitFor } from "./harness.mjs";

const s = suite("session pin");
const origin = originArg();
const { cookie, name, value } = forgeCookie(origin);
const title = "PIN-CHECK-" + Math.random().toString(36).slice(2, 7);

const created = await rpc(origin, cookie, "session/create", { request: { cwd: process.cwd() } });
const sessionId = created?.value?.sessionId;
if (typeof sessionId !== "string" || sessionId === "") {
  console.log("  skip: could not create a session on " + origin);
  process.exit(0);
}
await rpc(origin, cookie, "session/rename", { request: { sessionId, title } });
console.log(`  session: ${sessionId} ("${title}")`);

const chrome = await launchChrome({ port: 9348 });
if (chrome === undefined) {
  console.log("  skip browser checks (no Chrome found — set DSH_VERIFY_CHROME)");
  process.exit(0);
}

try {
  await chrome.cdp.send("Network.setCookie", { name, value, url: `${origin}/`, path: "/", sameSite: "Strict" });
  await chrome.cdp.send("Page.navigate", { url: `${origin}/?dshPanel=center&session=${encodeURIComponent(sessionId)}` });
  const booted = await waitFor(() => chrome.cdp.eval(`!!document.querySelector('[class$="_frame"]')`), { tries: 90, delay: 500 });
  await sleep(4000);
  const state = await chrome.cdp.eval(`(() => {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem('dsh.sessions.current') || 'null'); } catch {}
    const sidebar = document.querySelector('[class*="sidebarCol"]');
    return {
      panel: document.documentElement.getAttribute('data-dsh-panel'),
      stored,
      docTitle: document.title,
      sidebarHidden: sidebar !== null && getComputedStyle(sidebar).visibility === 'hidden',
    };
  })()`);
  console.log(`  localStorage: ${JSON.stringify(state.stored)} | title: ${JSON.stringify(state.docTitle)}`);
  s.check("app booted in center mode", booted && state.panel === "center");
  s.check("selection pinned before boot", state.stored?.sessionId === sessionId, JSON.stringify(state.stored));
  s.check("app opened on the pinned conversation", String(state.docTitle).includes(title), state.docTitle);
  s.check("sidebar column suppressed while pinned", state.sidebarHidden === true);
  s.check("no page JS errors", chrome.cdp.errors.length === 0, chrome.cdp.errors.slice(0, 2).join(" | "));
} finally {
  await chrome.close();
}

process.exit(s.finish() ? 0 : 1);
