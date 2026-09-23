// The generated shell page must RUN: the bootstrap that applies the "no editor
// tab yet" styling and reports iframe-ready to the host was once a SyntaxError,
// which silently killed the handshake and the host→iframe forwarding.
//
// Loaded in headless Chrome from a temp file (with acquireVsCodeApi shimmed, as
// VS Code does) and inspected for JS errors + executed side effects.
//
//   node scripts/verify/shell-check.mjs

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launchChrome, loadWithStubbedVscode, sleep, suite } from "./harness.mjs";

const s = suite("shell page");

const callable = () => new Proxy(function () {}, { get: (_t, p) => (p === "then" ? undefined : callable()), apply: () => callable(), construct: () => callable() });
const { shellHtml, stateBody } = loadWithStubbedVscode("out/webviewHtml.js", callable());

const info = { state: "running", url: process.env.DSH_VERIFY_ORIGIN?.trim() || "http://127.0.0.1:3080", panelSupport: true };
const SHIM = `<script>function acquireVsCodeApi(){return {postMessage:function(m){window.__posted=(window.__posted||[]).concat([m]);}};}</script>`;
const html = shellHtml(stateBody(info, "session-shell-check"), true).replace("<head>", "<head>" + SHIM);
const dir = mkdtempSync(path.join(tmpdir(), "dsh-verify-shell-"));
const file = path.join(dir, "shell.html");
writeFileSync(file, html);
s.check("shell embeds the GUI iframe", html.includes("<iframe"));
s.check("launcher-only CSS is gone", !html.includes(".launcher"));

const chrome = await launchChrome({ port: 9346 });
if (chrome === undefined) {
  console.log("  skip browser checks (no Chrome found — set DSH_VERIFY_CHROME)");
} else {
  try {
    await chrome.cdp.send("Page.navigate", { url: `file:///${file.replace(/\\/g, "/")}` });
    await sleep(3500);
    const state = await chrome.cdp.eval(`(() => {
      const f = document.querySelector('iframe');
      const injected = document.getElementById('dsh-no-tab');
      return {
        iframe: f !== null,
        src: f ? f.getAttribute('src') : null,
        noTabClass: document.documentElement.classList.contains('dsh-no-tab'),
        noTabStyleId: injected ? injected.id : null,
        noTabCssHasSelector: injected ? injected.textContent.includes('[class*="sessionRow"]') : false,
        noTabCssQuotesIntact: injected ? injected.textContent.includes('aria-selected="true"') : false,
        posted: window.__posted ?? [],
      };
    })()`);
    s.check("iframe mounted with the pinned URL", state.iframe === true && /dshPanel=center/.test(state.src ?? "") && /session=session-shell-check/.test(state.src ?? ""), state.src ?? "no src");
    s.check("bootstrap applied (dsh-no-tab class)", state.noTabClass === true);
    s.check("bootstrap injected its style element", state.noTabStyleId === "dsh-no-tab");
    s.check("injected CSS keeps its quotes", state.noTabCssHasSelector === true && state.noTabCssQuotesIntact === true);
    s.check(
      "iframe-ready handshake reached the host",
      (state.posted ?? []).some((m) => m?.type === "iframe-ready" && m?.source === "dsh-vscode-panel"),
      JSON.stringify(state.posted)
    );
    s.check("no page JS errors", chrome.cdp.errors.length === 0, chrome.cdp.errors.slice(0, 2).join(" | "));
  } finally {
    await chrome.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(s.finish() ? 0 : 1);
