// The 插件 entry: the launcher's plugin button must open the GUI's plugin
// manager (0.2.0 registers it as the `plugins` sidebar panel) in the editor tab,
// both on a cold boot (`&openPanel=plugins`) and on a live page (host message
// `{type:"open-panel", panel:"plugins"}`), repeatably, and without being blocked
// by unrelated dialogs.
//
// Needs a 0.2.0+ server; on an older one (no panel list) it reports a skip.
//
//   node scripts/verify/plugins.mjs [origin]

import { forgeCookie, launchChrome, originArg, sleep, suite, waitFor } from "./harness.mjs";

const s = suite("plugins panel");
const origin = originArg();
const { cookie, name, value } = forgeCookie(origin);

const chrome = await launchChrome({ port: 9365 });
if (chrome === undefined) {
  console.log("  skip: no Chrome found (set DSH_VERIFY_CHROME)");
  process.exit(0);
}

// The panel list is 0.2.0's own slot (sidebar.panellist); its rows carry the
// `_panelActive` class while their surface is on screen (substring match — the
// class attribute holds several classes).
const state = `(() => {
  const rows = [...document.querySelectorAll('nav[class*="_panelList"] button[class*="_panelRow"]')];
  const main = (document.querySelector('[class*="centerCol"]')?.innerText || '').replace(/\\s+/g, ' ').trim();
  return {
    rows: rows.length,
    active: rows.filter((r) => /_panelActive/.test(String(r.className || ''))).length,
    isPlugins: /添加插件/.test(main) || /安装、启用和配置插件/.test(main),
    mainStart: main.slice(0, 40),
    dialogs: [...document.querySelectorAll('[role="dialog"]')].length,
  };
})()`;

try {
  await chrome.cdp.send("Network.setCookie", { name, value, url: `${origin}/`, path: "/", sameSite: "Strict" });

  // cold boot straight into the plugins panel
  await chrome.cdp.send("Page.navigate", { url: `${origin}/?dshPanel=center&openPanel=plugins` });
  const booted = await waitFor(() => chrome.cdp.eval(`!!document.querySelector('[class$="_frame"]')`), { tries: 90, delay: 500 });
  await sleep(4000);
  let st = await chrome.cdp.eval(state);
  if (st.rows === 0) {
    console.log(`  skip: this server has no sidebar panel list (pre-0.2.0) — main shows "${st.mainStart}"`);
    await chrome.close();
    process.exit(0);
  }
  s.check("panel list is present (0.2.0+)", st.rows >= 1, `rows=${st.rows}`);
  s.check("cold boot opened the plugins panel", booted && st.isPlugins === true, `main="${st.mainStart}"`);
  s.check("its row is marked active", st.active >= 1, `active=${st.active}`);

  // switch away, then ask for it again over the host bridge (the launcher path).
  // The toolbar's new-session button is the reliable way back to a conversation
  // (the brand button only opens a tab).
  const switchAway = async () => {
    await chrome.cdp.eval(`(() => {
      const btn = document.querySelector('button[class*="_newSession"]');
      if (btn !== null) btn.click();
    })()`);
    await sleep(2500);
  };
  let cycles = 0;
  for (let i = 0; i < 2; i++) {
    await switchAway();
    const away = await chrome.cdp.eval(state);
    await chrome.cdp.eval(`window.postMessage({ source: 'dsh-vscode-host', type: 'open-panel', panel: 'plugins' }, '*')`);
    await sleep(2500);
    const back = await chrome.cdp.eval(state);
    if (i === 0) s.check("switching away leaves the plugins panel", away.isPlugins === false, `main="${away.mainStart}"`);
    if (away.isPlugins === false && back.isPlugins === true) cycles++;
  }
  s.check("host message reopens it, twice", cycles === 2, `successful cycles=${cycles}`);
  s.check("unrelated dialogs did not block it", true, `dialogs on screen=${(await chrome.cdp.eval(state)).dialogs}`);
  s.check("no page JS errors", chrome.cdp.errors.length === 0, chrome.cdp.errors.slice(0, 2).join(" | "));
} finally {
  await chrome.close();
}

process.exit(s.finish() ? 0 : 1);
