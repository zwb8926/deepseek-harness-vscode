/**
 * Shared webview shell HTML for the DeepSeek Harness UI.
 *
 * Used by both the tab panel (ChatPanel) and the sidebar view
 * (ChatViewProvider). The shell embeds the running dsh SPA in an iframe
 * (same-origin inside the iframe, so the browser-trust fence passes) and
 * shows placeholders/actions for every other server state.
 */

import type { DshRuntimeInfo } from "./dshManager";

export interface PanelAction {
  type: "new-session" | "open-chat" | "open-settings" | "open-browser" | "start" | "stop" | "restart" | "reload" | "show-logs";
}

const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "frame-src http://127.0.0.1:* http://localhost:*",
  "img-src data: https:",
  "connect-src 'none'",
  "font-src 'none'",
  "base-uri 'none'"
].join("; ");

const BASE_CSS = `
html, body { margin: 0; padding: 0; height: 100%; }
body {
  font-family: var(--vscode-font-family, system-ui);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  display: flex; flex-direction: column;
}
#stage { flex: 1; display: flex; flex-direction: column; }
#stage iframe { width: 100%; height: 100%; border: 0; flex: 1; background: var(--vscode-editor-background); }
.placeholder {
  flex: 1; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 14px; text-align: center; padding: 32px;
}
.spinner {
  width: 34px; height: 34px; border-radius: 50%;
  border: 3px solid var(--vscode-progressBar-background, #0e639c);
  border-top-color: transparent;
  animation: spin 0.9s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
h1 { font-size: 16px; font-weight: 600; margin: 0; }
p { margin: 0; color: var(--vscode-descriptionForeground); font-size: 13px; max-width: 560px; line-height: 1.5; }
code { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px;
  background: var(--vscode-textCodeBlock-background); padding: 2px 6px; border-radius: 4px; }
.actions { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; justify-content: center; }
button {
  border: 1px solid var(--vscode-button-border, transparent);
  background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 13px;
}
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
`;

/** The "no editor tab open yet" rule the shell injects into the page: it hides
 * the GUI's row highlight until the extension confirms the tab is up. Kept as a
 * TS constant and embedded with JSON.stringify — hand-written \\" escapes inside
 * the shell template were emitted as BARE quotes, which turned the whole
 * bootstrap script into a SyntaxError (so the iframe-ready handshake and the
 * host→iframe forwarding never ran). */
const NO_TAB_CSS =
  'html.dsh-no-tab [class*="sessionRow"][class*="selected"],' +
  'html.dsh-no-tab [class*="sessionRow"][aria-selected="true"] {' +
  "background: transparent !important;" +
  "color: inherit !important;" +
  "box-shadow: none !important;}";

export function shellHtml(body: string, dark: boolean): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeepSeek Harness</title>
<style>${BASE_CSS}
/* Drive the nested iframe's prefers-color-scheme from the VS Code theme. */
:root { color-scheme: ${dark ? "dark" : "light"}; }
</style>
</head>
<body>
<div id="stage">${body}</div>
<script>
(function () {
  const vscode = acquireVsCodeApi();
  document.querySelectorAll("button[data-cmd]").forEach(function (b) {
    b.addEventListener("click", function () {
      vscode.postMessage({ type: b.getAttribute("data-cmd") });
    });
  });
  // The embedded GUI iframe (sidebar panel) reports session picks and
  // settings requests — open or reveal the editor tab so the conversation /
  // settings are visible.
  //
  // We only need to gate on data.source (the iframe runs panel-inject.js
  // which sets that field). Checking e.source against the current
  // frame.contentWindow is unreliable: when the launcher HTML is
  // re-rendered (e.g. on a state transition), the old frame reference
  // in this closure becomes stale, and messages from the new iframe
  // are dropped. Trust the message tag — only the panel-inject script
  // ever sets source = "dsh-vscode-panel".
  window.addEventListener("message", function (e) {
    const data = e.data;
    if (data === null || typeof data !== "object" || data.source !== "dsh-vscode-panel") return;
    if (data.type === "session-selected") vscode.postMessage({ type: "open-chat" });
    else if (data.type === "settings-selected") vscode.postMessage({ type: "open-settings" });
  });
  // Forward host → iframe messages (e.g. "the editor tab was opened /
  // closed"). The iframe's panel-inject script listens for these and
  // reacts (toggles the no-tab CSS class, etc.). A session-closed
  // message also restores the default "no current" highlight until
  // the user picks a session again.
  window.addEventListener("message", function (e) {
    const data = e.data;
    if (data === null || typeof data !== "object" || data.source !== "dsh-vscode-host") return;
    const frame = document.querySelector("iframe");
    if (frame === null || frame.contentWindow === null) return;
    try { frame.contentWindow.postMessage(data, "*"); } catch (err) { /* iframe gone */ }
  });
  // On launcher activation there is no editor tab open yet, so the
  // sidebar should start in its no-highlight state. The first
  // session- / settings-selected message from the iframe will be
  // paired with the extension opening the editor tab, after which
  // the extension posts "session-opened" to lift the no-highlight
  // class. The rule text is interpolated as a JSON literal: building it
  // through a nested script string lost one escaping level and made this
  // whole bootstrap a SyntaxError.
  document.documentElement.classList.add("dsh-no-tab");
  const noTabStyle = document.createElement("style");
  noTabStyle.id = "dsh-no-tab";
  noTabStyle.textContent = ${JSON.stringify(NO_TAB_CSS)};
  document.head.appendChild(noTabStyle);
  // Report when the embedded GUI iframe has loaded so the extension knows it can
  // deliver host messages (panel-inject must be running inside it first). This
  // used to reference a build-time constant by name, which the browser cannot
  // see — so the handshake never fired.
  const frame = document.querySelector("iframe");
  if (frame !== null) {
    frame.addEventListener("load", function () {
      try { vscode.postMessage({ source: "dsh-vscode-panel", type: "iframe-ready" }); } catch (err) {}
    });
  }
})();
</script>
</body>
</html>`;
}

function actionsHtml(actions: Array<[string, string]>): string {
  const buttons = actions
    .map(([cmd, label]) => `<button data-cmd="${cmd}">${label}</button>`)
    .join("");
  return `<div class="actions">${buttons}</div>`;
}

/** Browser-session auth fallback (dsh 0.1.2+): the GUI exchanges ?token= for
 * a SameSite=Strict cookie at GET /, so a cross-origin webview iframe cannot
 * authenticate. The webview shows the URL and offers the browser instead. */
function browserAuthFallback(url: string, status: string, extra?: string): string {
  return `<div class="launcher">
  <div class="hint">
    <h1>DeepSeek Harness</h1>
    <p>当前 dsh 使用浏览器会话鉴权（Cookie），无法在 VS Code 内嵌面板中打开 GUI。</p>
    <p>请在浏览器中打开（左侧栏的会话与工作区仍可正常使用）。</p>
    <p><code>${escapeHtml(url)}</code></p>
    ${actionsHtml([["open-browser", "在浏览器打开"], ["show-logs", "查看日志"]])}
  </div>
  ${extra ?? ""}
  ${status}
</div>`;
}

function placeholderHtml(title: string, detail: string): string {
  return `<div class="placeholder">
  <div class="spinner"></div>
  <h1>${title}</h1>
  <p>${detail}</p>
  <p><code>DeepSeek Harness</code> logs keep the full startup trace.</p>
</div>`;
}

/** The iframe sandbox/allow attributes the embedded GUI needs (same-origin
 * inside the iframe, so the browser-trust fence passes and localStorage is
 * shared between the launcher and the editor on the dsh origin). */
const IFRAME_ATTRS =
  'sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock"' +
  ' allow="clipboard-read; clipboard-write"';

function guiIframeHtml(src: string, title: string): string {
  return `<iframe title="${title}" src="${escapeHtml(src)}" ${IFRAME_ATTRS}></iframe>`;
}

/** Split-panel iframe source for the editor shell (the center column), when the
 * frontend supports it. When `sessionId` is given, the iframe is pinned to that
 * conversation: the panel-inject script reads `?session=` and forces
 * `dsh.sessions.current`, so the editor tab shows THAT conversation —
 * independent of the shared localStorage that the GUI sidebar writes — and
 * clicking another session simply re-renders this same tab with a new pin.
 * `opts.seedSession` writes the same selection ONCE but leaves the tab
 * following the GUI (used by the default/settings view so it never falls back
 * to a stale new-session view); `opts.openSettings` makes panel-inject click
 * the settings trigger at boot (no host-message timing involved). */
function panelSrc(url: string, panel: "center", supported: boolean, sessionId?: string, opts?: { seedSession?: string; openSettings?: boolean }): string {
  if (!supported) return url;
  const sep = url.includes("?") ? "&" : "?";
  let src = `${url}${sep}dshPanel=${panel}`;
  const sid = sessionId ?? opts?.seedSession;
  if (sid !== undefined && sid !== "") {
    src += `&session=${encodeURIComponent(sid)}`;
    if (sessionId === undefined) src += "&seed=1";
  }
  if (opts?.openSettings === true) src += "&openSettings=1";
  return src;
}

/** Sidebar panel: the GUI's own sidebar column (sessions / workspaces). */
/** Build the #stage body for one runtime state. When `sessionId` is given,
 * the embedded GUI is pinned to that conversation (`?session=` param).
 * `opts.seedSession` seeds the selection once without pinning; `opts.openSettings`
 * auto-opens the settings modal in the loaded page. */
export function stateBody(info?: DshRuntimeInfo, sessionId?: string, opts?: { seedSession?: string; openSettings?: boolean }): string {
  switch (info?.state) {
    case "running": {
      const url = info.url ?? "";
      // Editor area = the GUI's center column (conversation + details), no
      // sidebar. Full GUI when the frontend lacks split-panel support.
      const embedBase = info.guiUrl ?? url;
      if (info.browserAuth === true && info.guiUrl === undefined) {
        return browserAuthFallback(url, "");
      }
      const src = panelSrc(embedBase, "center", info.panelSupport !== false, sessionId, opts);
      return guiIframeHtml(src, "DeepSeek Harness");
    }
    case "locating":
      return placeholderHtml("Locating the dsh CLI…", "The extension is looking for an existing dsh installation (bundled, PATH, global npm).");
    case "installing":
      return placeholderHtml("Installing DeepSeek Harness…", "npm install @deepseek-ai/dsh into the extension storage is running (one-time, about 200&thinsp;MB). The chat UI appears automatically when the server is up.");
    case "starting":
      return placeholderHtml("Starting DeepSeek Harness…", "The dsh web server is booting. This can take a few seconds on first launch.");
    case "error":
      return `<div class="placeholder">
        <h1>DeepSeek Harness failed to start</h1>
        <p>${escapeHtml(info.detail ?? "Unknown error")}</p>
        <p>See the <code>DeepSeek Harness</code> output channel for the full startup log.</p>
        ${actionsHtml([["start", "Retry"], ["open-browser", "Open in Browser"], ["show-logs", "Show Logs"]])}
      </div>`;
    case "stopped":
    default:
      return `<div class="placeholder">
        <h1>DeepSeek Harness is not running</h1>
        <p>The dsh web server is stopped. Start it to open the chat UI, or open the running GUI in your browser.</p>
        ${actionsHtml([["start", "Start Server"], ["open-browser", "Open in Browser"], ["show-logs", "Show Logs"]])}
      </div>`;
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
