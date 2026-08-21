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
  type: "new-session" | "open-chat" | "open-browser" | "start" | "stop" | "restart" | "reload" | "show-logs";
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
.launcher { display: flex; flex-direction: column; gap: 10px; padding: 12px; }
.launcher h1 { font-size: 13px; margin: 0; }
.launcher button.primary { padding: 8px 0; font-weight: 600; }
.launcher .status {
  font-size: 11px; line-height: 1.5; padding: 6px 8px; border-radius: 6px;
  background: var(--vscode-textBlockQuote-background);
  border: 1px solid var(--vscode-widget-border, transparent);
  color: var(--vscode-descriptionForeground);
  word-break: break-all;
}
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

/** Sidebar panel: one button to create & open a session, plus server status. */
export function launcherBody(info?: DshRuntimeInfo): string {
  const status =
    info?.state === "running" && info.url !== undefined
      ? `<div class="status">${escapeHtml(info.url)}${info.external === true ? " (adopted)" : ""}</div>`
      : `<div class="status">${stateLabelOf(info)}</div>`;
  return `<div class="launcher">
  <h1>DeepSeek Harness</h1>
  <button class="primary" data-cmd="new-session">打开DSH</button>
  ${status}
</div>`;
}

function stateLabelOf(info?: DshRuntimeInfo): string {
  switch (info?.state) {
    case "running":
      return "运行中";
    case "locating":
      return "正在定位 dsh CLI…";
    case "installing":
      return "正在安装…";
    case "starting":
      return "正在启动…";
    case "error":
      return "错误 — " + escapeHtml(info.detail ?? "未知");
    case "stopped":
      return "已停止";
    default:
      return "空闲";
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
