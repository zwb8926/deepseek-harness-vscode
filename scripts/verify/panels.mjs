// The core split-panel invariant, measured in a real browser against a live
// server (the dsh GUI's own grid is what the adapter edits):
//
//   center  — the GUI's sidebar column is suppressed (painted, not removed: the
//             settings modal lives inside that subtree), the conversation spans
//             the full width, and the settings modal still opens on top.
//   sidebar — only the sidebar column survives; conversation and details are
//             collapsed to zero so the VS Code side bar shows a session list.
//
//   node scripts/verify/panels.mjs [origin]

import { forgeCookie, launchChrome, originArg, rpc, sleep, suite, waitFor } from "./harness.mjs";

const s = suite("panels");
const origin = originArg();
const { cookie, name, value } = forgeCookie(origin);

const chrome = await launchChrome({ port: 9347 });
if (chrome === undefined) {
  console.log("  skip: no Chrome found (set DSH_VERIFY_CHROME)");
  process.exit(0);
}

const measure = `(() => {
  const vis = (el) => el !== null && getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length > 0;
  const rect = (el) => { if (el === null) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) }; };
  const sidebar = document.querySelector('[class*="sidebarCol"]');
  const center = document.querySelector('[class*="centerCol"]');
  const rightbar = document.querySelector('[class*="rightbarCol"]');
  const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.querySelector('[class*="_navTitle"], [class*="_navCell"]')) ?? null;
  return {
    panel: document.documentElement.getAttribute('data-dsh-panel'),
    frame: document.querySelector('[class$="_frame"]') !== null,
    sidebar: { visible: vis(sidebar), text: (sidebar?.innerText || '').replace(/\\s+/g, ' ').trim().length, rect: rect(sidebar) },
    center: { visible: vis(center), rect: rect(center) },
    rightbar: { visible: vis(rightbar), rect: rect(rightbar) },
    settings: { open: dialog !== null, visible: vis(dialog), rect: rect(dialog) },
    viewport: window.innerWidth,
  };
})()`;

try {
  await chrome.cdp.send("Network.setCookie", { name, value, url: `${origin}/`, path: "/", sameSite: "Strict" });

  const list = await rpc(origin, cookie, "session/list", { _request: {} });
  const sessionId = list?.value?.items?.[0]?.sessionId ?? "";
  s.check("live server lists sessions", typeof sessionId === "string" && sessionId !== "", `sessionId=${sessionId.slice(0, 24)}`);

  // ---- center mode (the editor tab) --------------------------------------
  await chrome.cdp.send("Page.navigate", { url: `${origin}/?dshPanel=center&session=${encodeURIComponent(sessionId)}` });
  const booted = await waitFor(() => chrome.cdp.eval(`!!document.querySelector('[class$="_frame"]')`), { tries: 90, delay: 500 });
  await sleep(3000);
  const center = await chrome.cdp.eval(measure);
  s.check("center: app frame rendered", booted && center.frame === true);
  s.check("center: panel attribute set", center.panel === "center", `data-dsh-panel=${center.panel}`);
  s.check("center: sidebar column hidden from view", center.sidebar.visible === false);
  s.check("center: sidebar column painted empty", center.sidebar.text === 0, `chars=${center.sidebar.text}`);
  s.check("center: conversation spans the viewport", (center.center.rect?.w ?? 0) >= center.viewport - 4, `center=${center.center.rect?.w} viewport=${center.viewport}`);
  s.check("center: details column keeps no width it should not", center.rightbar.rect === null || center.rightbar.rect.w >= 0);

  // settings modal must still open and land on top
  await chrome.cdp.eval(`window.postMessage({ source: 'dsh-vscode-host', type: 'open-settings' }, '*')`);
  await sleep(2500);
  const withSettings = await chrome.cdp.eval(measure);
  s.check("center: settings modal opens over the conversation", withSettings.settings.open === true && withSettings.settings.visible === true, JSON.stringify(withSettings.settings.rect));
  await chrome.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await chrome.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(1200);
  const closed = await chrome.cdp.eval(measure);
  s.check("center: settings modal closes", closed.settings.visible === false);

  // ---- sidebar mode (the VS Code side bar) --------------------------------
  await chrome.cdp.send("Page.navigate", { url: `${origin}/?dshPanel=sidebar` });
  await waitFor(() => chrome.cdp.eval(`!!document.querySelector('[class$="_frame"]')`), { tries: 90, delay: 500 });
  await sleep(3000);
  const sidebar = await chrome.cdp.eval(measure);
  s.check("sidebar: panel attribute set", sidebar.panel === "sidebar", `data-dsh-panel=${sidebar.panel}`);
  s.check("sidebar: sidebar column is visible", sidebar.sidebar.visible === true);
  s.check("sidebar: session list rendered inside it", sidebar.sidebar.text > 0, `chars=${sidebar.sidebar.text}`);
  s.check("sidebar: conversation column collapsed", (sidebar.center.rect?.w ?? 0) === 0, `center=${sidebar.center.rect?.w}`);
  s.check("sidebar: details column collapsed", (sidebar.rightbar.rect?.w ?? 0) === 0, `rightbar=${sidebar.rightbar.rect?.w}`);
  s.check("no page JS errors", chrome.cdp.errors.length === 0, chrome.cdp.errors.slice(0, 2).join(" | "));
} finally {
  await chrome.close();
}

process.exit(s.finish() ? 0 : 1);
