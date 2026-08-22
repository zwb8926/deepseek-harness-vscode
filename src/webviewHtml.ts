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
.launcher { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.launcher iframe { flex: 1 1 0; min-height: 0; width: 100%; border: 0; background: var(--vscode-editor-background); }
.launcher .status {
  flex: none; font-size: 11px; line-height: 1.5; padding: 6px 8px; border-radius: 0;
  border-top: 1px solid var(--vscode-widget-border, transparent);
  background: var(--vscode-textBlockQuote-background);
  color: var(--vscode-descriptionForeground);
  word-break: break-all;
}
.launcher .hint {
  flex: 1; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 10px; text-align: center; padding: 16px;
}
.launcher .hint h1 { font-size: 13px; margin: 0; }
`;

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
  // class.
  const initial = document.createElement("script");
  initial.textContent =
    "document.documentElement.classList.add('dsh-no-tab');" +
    "var s=document.createElement('style');" +
    "s.id='dsh-no-tab';" +
    "s.textContent='html.dsh-no-tab [class*=\"sessionRow\"][class*=\"selected\"],'+" +
      "'html.dsh-no-tab [class*=\"sessionRow\"][aria-selected=\"true\"] {'+" +
      "'background: transparent !important;'+" +
      "'color: inherit !important;'+" +
      "'box-shadow: none !important;}';" +
    "document.head.appendChild(s);";
  document.head.appendChild(initial);
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

/** The iframe sandbox/allow attributes the embedded GUI needs (same-origin
 * inside the iframe, so the browser-trust fence passes and localStorage is
 * shared between the launcher and the editor on the dsh origin). */
const IFRAME_ATTRS =
  'sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock"' +
  ' allow="clipboard-read; clipboard-write"';

function guiIframeHtml(src: string, title: string): string {
  return `<iframe title="${title}" src="${escapeHtml(src)}" ${IFRAME_ATTRS}></iframe>`;
}

/** Split-panel iframe source for one panel mode, when the frontend supports it. */
function panelSrc(url: string, panel: "sidebar" | "center", supported: boolean): string {
  if (!supported) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}dshPanel=${panel}`;
}

/** Sidebar panel: the GUI's own sidebar column (sessions / workspaces). */
export function launcherBody(info?: DshRuntimeInfo): string {
  const status =
    info?.state === "running" && info.url !== undefined
      ? `<div class="status">${escapeHtml(info.url)}${info.external === true ? " (adopted)" : ""}</div>`
      : `<div class="status">${stateLabelOf(info)}</div>`;
  const project =
    info?.project !== undefined && info.project !== ""
      ? `<div class="status">📁 ${escapeHtml(info.project)}</div>`
      : "";
  if (info?.state === "running" && info.url !== undefined) {
    if (info.panelSupport === false) {
      return `<div class="launcher">
  <div class="hint">
    <h1>DeepSeek Harness</h1>
    <p>当前 dsh 前端不支持拆分面板（缺少 split-panel 补丁）。请更新 dsh 或检查日志。</p>
    <p><code>${escapeHtml(info.url)}</code></p>
  </div>
  ${project}
  ${status}
</div>`;
    }
    const src = panelSrc(info.url, "sidebar", true);
    return `<div class="launcher">
  ${guiIframeHtml(src, "DeepSeek Harness — sessions")}
  ${project}
  ${status}
</div>`;
  }
  const hintText =
    info?.state === "error"
      ? `启动失败：${escapeHtml(info.detail ?? "未知错误")}`
      : info?.state === "locating" || info?.state === "starting" || info?.state === "installing"
        ? "服务正在启动…"
        : "服务未运行。";
  const hintActions =
    info?.state === "error" || info?.state === "stopped" || info?.state === undefined || info?.state === "idle"
      ? actionsHtml([["start", "启动服务"], ["open-browser", "浏览器打开"], ["show-logs", "查看日志"]])
      : "";
  return `<div class="launcher">
  <div class="hint">
    <h1>DeepSeek Harness</h1>
    <p>${hintText}</p>
    ${hintActions}
  </div>
  ${project}
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
      // Editor area = the GUI's center column (conversation + details), no
      // sidebar. Full GUI when the frontend lacks split-panel support.
      const src = panelSrc(url, "center", info.panelSupport !== false);
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
