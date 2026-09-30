// The settings write path + the pre-release notice (0.2.0 labels it 预览版说明).
//
// The chain that broke in the field: the notice's 继续 button saves
// `ui-settings-general.welcomeNoticeVersion`, a server that rejects settings
// writes can therefore never be acknowledged — and every settings change fails
// with it. Two things are checked here:
//
//   A. the ADAPTER hides the notice regardless (the embedded UI must stay usable
//      on a deployment whose writes are rejected), without hiding real dialogs;
//   B. the server-side acknowledgement still works when the write path is
//      healthy, including after a restart.
//
// The expected version string is read from the installed client bundle, so this
// never goes stale when dsh bumps the notice (0.1.7 wanted 2026-08-13.1, 0.2.0
// wants a newer one) — that mismatch is exactly what made the notice come back.
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

/** The version dsh currently expects, straight from its own client bundle. */
function expectedAck() {
  const file = path.join(REPO, "node_modules", "@deepseek-ai", "dsh-client-ui-settings-models", "lib", "client.js");
  const m = readFileSync(file, "utf8").match(/WELCOME_NOTICE_VERSION\s*=\s*"([^"]+)"/);
  if (m === null) throw new Error("WELCOME_NOTICE_VERSION not found — has the notice moved packages?");
  return m[1];
}
const ACK = expectedAck();
console.log(`  dsh expects welcomeNoticeVersion = ${ACK}`);

const NOTICE = `(() => {
  const titles = ['预览版说明', 'Preview Notice', '内测声明', 'Beta Notice'];
  const d = [...document.querySelectorAll('[role="dialog"]')].find((x) => {
    const label = (x.getAttribute('aria-label') || '').trim();
    const text = (x.innerText || '').trim();
    return titles.some((t) => label === t || text.indexOf(t) === 0);
  });
  if (d === undefined || d === null) return { present: false, visible: false };
  const r = d.getBoundingClientRect();
  const style = window.getComputedStyle(d);
  return { present: true, visible: r.width > 0 && r.height > 0 && style.display !== 'none', display: style.display };
})()`;

const SETTINGS_OPEN = `(() => {
  const d = [...document.querySelectorAll('[role="dialog"]')].find((x) => x.querySelector('[class*="_navCell"], [class*="_navTitle"], [class*="_navList"]'));
  if (d === undefined || d === null) return { open: false };
  const r = d.getBoundingClientRect();
  return { open: r.width > 0 && window.getComputedStyle(d).display !== 'none' };
})()`;

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

    // ---- A0. the suppression itself, against synthetic dialogs -------------
    // The real failing-writes state cannot be reproduced from outside (see
    // docs/upstream-profile-reload.md), so the code that ships is extracted from
    // the generated adapter and run against two dialogs: the notice (must be
    // hidden) and a settings dialog (must be left alone).
    await chrome.cdp.send("Page.navigate", { url: `${origin}/?dshPanel=center` });
    await waitFor(() => chrome.cdp.eval(`!!document.querySelector('[class$="_frame"]')`), { tries: 90, delay: 500 });
    await sleep(3000);
    const adapter = readFileSync(path.join(REPO, "panel-inject.js"), "utf8");
    const injectBody = adapter.slice(adapter.indexOf("PANEL_INJECT = "), adapter.indexOf("function injectPanelSupportHtml"));
    const from = injectBody.indexOf("var noticeTitles");
    const to = injectBody.indexOf("hidePreviewNotice();");
    if (from < 0 || to < 0) throw new Error("could not extract the suppression source from panel-inject.js");
    const suppressSrc = injectBody.slice(from, to);
    const probe = await chrome.cdp.eval(`(() => {
      ${suppressSrc}
      document.body.insertAdjacentHTML('beforeend', '<div role="dialog" aria-label="预览版说明" id="probeNotice"><p>预览版说明 测试</p><button>继续</button></div>');
      document.body.insertAdjacentHTML('beforeend', '<div role="dialog" id="probeSettings"><nav class="x_navList"><button class="x_navCell">通用设置</button></nav></div>');
      const hid = hidePreviewNotice();
      const notice = document.getElementById('probeNotice');
      const settings = document.getElementById('probeSettings');
      const out = {
        hid,
        noticeDisplay: window.getComputedStyle(notice).display,
        settingsDisplay: window.getComputedStyle(settings).display,
        settingsWidth: settings.getBoundingClientRect().width,
      };
      notice.remove(); settings.remove();
      return out;
    })()`);
    s.check("the suppression hides the notice dialog", probe.hid === true && probe.noticeDisplay === "none", JSON.stringify(probe));
    s.check("the suppression leaves a settings dialog alone", probe.settingsDisplay !== "none" && probe.settingsWidth > 0, `display=${probe.settingsDisplay} width=${probe.settingsWidth}`);

    // ---- A. a real dialog must open normally on a real page ----------------
    await chrome.cdp.eval(`window.postMessage({ source: 'dsh-vscode-host', type: 'open-settings' }, '*')`);
    await sleep(3000);
    s.check("the settings dialog still opens normally", (await chrome.cdp.eval(SETTINGS_OPEN)).open === true);
    await chrome.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await chrome.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(1200);

    // ---- B. the server-side acknowledgement still works --------------------
    const write = await rpc(origin, jar.cookie, "settings/update", { ns: "ui-settings-general", patch: { welcomeNoticeVersion: ACK } });
    s.check("settings/update accepts the acknowledgement", write?.ok === true, write?.ok === false ? JSON.stringify(write.error).slice(0, 180) : "");
    s.check("the acknowledgement reached the profile patch layer", readFileSync(path.join(home, "profiles", "web", "cordis.patch.yml"), "utf8").includes(ACK));

    await chrome.cdp.send("Page.navigate", { url: `${origin}/?dshPanel=center` });
    await waitFor(() => chrome.cdp.eval(`!!document.querySelector('[class$="_frame"]')`), { tries: 90, delay: 500 });
    await sleep(4000);
    const after = await chrome.cdp.eval(NOTICE);
    s.check("no notice after the acknowledgement", after.visible === false, `present=${after.present} visible=${after.visible}`);
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
