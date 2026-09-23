// Single editor tab: clicking sessions must reuse ONE tab (revealed, re-pinned),
// never open a second one. Drives the compiled ChatPanel with a stubbed vscode
// host that records every created webview panel.
//
//   node scripts/verify/panel-tabs.mjs

import { loadWithStubbedVscode, suite } from "./harness.mjs";

const created = [];
function makePanel(title) {
  const panel = {
    title,
    iconPath: undefined,
    revealCount: 0,
    posted: [],
    html: "",
    _disposeHandlers: [],
    _messageHandlers: [],
    webview: {
      html: "",
      postMessage: (msg) => { panel.posted.push(msg); },
      onDidReceiveMessage: (fn) => { panel._messageHandlers.push(fn); return { dispose() {} }; },
    },
    reveal() { this.revealCount++; },
    onDidDispose(fn) { this._disposeHandlers.push(fn); return { dispose() {} }; },
    dispose() { for (const fn of this._disposeHandlers) fn(); },
  };
  Object.defineProperty(panel, "html", {
    get() { return panel.webview.html; },
    set(v) { panel.webview.html = v; },
  });
  return panel;
}

const vscodeStub = {
  ViewColumn: { Active: -1 },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  Uri: { joinPath: (base, ...parts) => ({ fsPath: [base?.fsPath ?? base, ...parts].join("/") }) },
  window: {
    activeColorTheme: { kind: 2 },
    createWebviewPanel: (_viewType, title) => {
      const panel = makePanel(title);
      created.push(panel);
      return panel;
    },
  },
};

const { ChatPanel } = loadWithStubbedVscode("out/chatPanel.js", vscodeStub);
const s = suite("panel tabs");
const panel = new ChatPanel(() => {}, { fsPath: "ext" }, () => {}, () => {});
// The panel only embeds an iframe once it knows the server is up.
panel.update({ state: "running", url: "http://127.0.0.1:3080", panelSupport: true });
const ready = () => { for (const fn of created.at(-1)._messageHandlers) fn({ source: "dsh-vscode-panel", type: "iframe-ready" }); };

panel.openSession("session-AAA", "Session A");
s.check("first click creates one tab", created.length === 1, `panels=${created.length}`);
s.check("tab is pinned to session A", created[0].webview.html.includes("session=session-AAA"));
s.check("tab titled after the session", created[0].title === "Session A", `title=${created[0].title}`);
const revealAfterFirst = created[0].revealCount;

panel.openSession("session-BBB", "Session B");
s.check("second click does NOT open another tab", created.length === 1, `panels=${created.length}`);
s.check(
  "same tab now carries session B",
  created[0].webview.html.includes("session=session-BBB") && !created[0].webview.html.includes("session=session-AAA")
);
s.check("tab revealed (brought to front)", created[0].revealCount > revealAfterFirst, `revealCount=${created[0].revealCount}`);
s.check("tab retitled to session B", created[0].title === "Session B", `title=${created[0].title}`);

panel.openSession("session-AAA");
s.check("third click still one tab", created.length === 1, `panels=${created.length}`);
s.check("switched back to session A", created[0].webview.html.includes("session=session-AAA"));
s.check("untitled switch resets the tab title", created[0].title === "DeepSeek Harness", `title=${created[0].title}`);

panel.open();
s.check("Open Chat keeps the same tab", created.length === 1, `panels=${created.length}`);

panel.setPanelTitle("session-BBB", "renamed elsewhere");
s.check("rename of another session does not retitle the tab", created[0].title === "DeepSeek Harness", `title=${created[0].title}`);
panel.setPanelTitle("session-AAA", "Session A renamed");
s.check("rename of the shown session retitles the tab", created[0].title === "Session A renamed", `title=${created[0].title}`);

created[0].posted = [];
ready();
panel.postToGui({ type: "open-settings" }, "session-BBB");
s.check("host message for a switched-away session is dropped", created[0].posted.length === 0, JSON.stringify(created[0].posted));
ready();
panel.postToGui({ type: "open-settings" }, "session-AAA");
s.check("host message for the shown session is delivered", created[0].posted.length === 1, JSON.stringify(created[0].posted));

panel.openSettings("session-AAA");
s.check("settings flow reuses the tab", created.length === 1, `panels=${created.length}`);
s.check(
  "settings flow asks the LIVE page (no reload)",
  created[0].posted.at(-1)?.type === "open-settings",
  JSON.stringify(created[0].posted)
);
s.check("settings flow keeps the session pin", created[0].webview.html.includes("session=session-AAA"));

created[0].dispose();
panel.openSession("session-CCC", "Session C");
s.check("after the tab is closed, one new tab is created", created.length === 2, `panels=${created.length}`);
s.check("recreated tab is pinned to session C", created[1].webview.html.includes("session=session-CCC"));

process.exit(s.finish() ? 0 : 1);
