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
  type: "open-chat" | "open-browser" | "start" | "stop" | "restart" | "reload" | "show-logs";
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
:root { color-scheme: light dark; }
html, body { margin: 0; padding: 0; height: 100%; }
body {
  font-family: var(--vscode-font-family, system-ui);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  display: flex; flex-direction: column;
}
#stage { flex: 1; display: flex; flex-direction: column; }
#stage iframe { width: 100%; height: 100%; border: 0; flex: 1; background: #fff; }
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
.launcher { display: flex; flex-direction: column; gap: 12px; padding: 12px; }
.launcher h1 { font-size: 14px; }
.launcher .status {
  font-size: 12px; line-height: 1.6; padding: 8px 10px; border-radius: 6px;
  background: var(--vscode-textBlockQuote-background);
  border: 1px solid var(--vscode-widget-border, transparent);
}
.launcher .status .state { font-weight: 600; }
.launcher .status .state.running { color: var(--vscode-testing-iconPassed, #4ec9b0); }
.launcher .status .state.error { color: var(--vscode-testing-iconFailed, #f14c4c); }
.launcher .row { display: flex; gap: 6px; flex-wrap: wrap; }
.launcher button { flex: 1; min-width: 90px; }
.launcher p.hint { font-size: 11px; color: var(--vscode-descriptionForeground); }
`;

export function shellHtml(body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeepSeek Harness</title>
<style>${BASE_CSS}</style>
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

function placeholderHtml(title: string, detail: string): string {
  return `<div class="placeholder">
  <div class="spinner"></div>
  <h1>${title}</h1>
  <p>${detail}</p>
  <p><code>DeepSeek Harness</code> logs keep the full startup trace.</p>
</div>`;
}

/** Sidebar launcher: server state + actions. The chat UI itself lives in the editor. */
export function launcherBody(info?: DshRuntimeInfo): string {
  const stateLabel = stateLabelOf(info);
  const stateClass = info?.state === "running" ? "running" : info?.state === "error" ? "error" : "";
  const urlText =
    info?.state === "running" && info.url !== undefined
      ? `<br><code>${escapeHtml(info.url)}</code>${info.external === true ? " <em>(adopted)</em>" : ""}`
      : "";
  return `<div class="launcher">
  <h1>DeepSeek Harness</h1>
  <div class="status"><span class="state ${stateClass}">${stateLabel}</span>${urlText}</div>
  <div class="row">
    <button data-cmd="open-chat">Open Chat</button>
    <button data-cmd="open-browser">Browser</button>
  </div>
  <div class="row">
    <button data-cmd="start">Start</button>
    <button data-cmd="stop">Stop</button>
    <button data-cmd="restart">Restart</button>
  </div>
  <div class="row">
    <button data-cmd="reload">Reload</button>
    <button data-cmd="show-logs">Logs</button>
  </div>
  <p class="hint">The chat opens as an editor tab, like Claude Code.</p>
</div>`;
}

function stateLabelOf(info?: DshRuntimeInfo): string {
  switch (info?.state) {
    case "running":
      return "Running";
    case "locating":
      return "Locating dsh CLI…";
    case "installing":
      return "Installing…";
    case "starting":
      return "Starting…";
    case "error":
      return "Error — " + escapeHtml(info.detail ?? "unknown");
    case "stopped":
      return "Stopped";
    default:
      return "Idle";
  }
}

/** Build the #stage body for one runtime state. */
export function stateBody(info?: DshRuntimeInfo): string {
  switch (info?.state) {
    case "running": {
      const url = info.url ?? "";
      return `<iframe title="DeepSeek Harness" src="${escapeHtml(url)}"
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock"
        allow="clipboard-read; clipboard-write"></iframe>`;
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
