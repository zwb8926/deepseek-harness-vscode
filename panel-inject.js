// Shared split-panel adapter for the dsh web frontend.
//
// DeepSeek Harness for VS Code embeds the dsh GUI twice: the sidebar column
// (sessions / workspaces list) inside the VS Code sidebar, and the center
// column (conversation + details) inside an editor tab. The GUI itself knows
// nothing about this split, so a small script is injected into the served
// index.html (build time for the bundled dsh, at runtime for adopted
// servers). It reads `?dshPanel=sidebar|center` and adapts the AppFrame
// three-column grid with CSS only:
//
//   - sidebar: keep only the sidebar column and force the frame to the wide
//     breakpoint (SIDEBAR_AUTO_COLLAPSE = 1024px) so the sidebar renders
//     expanded instead of collapsing to the 56px rail in a narrow viewport.
//   - center: drop the sidebar column (and its drag handle) and let the
//     conversation span tracks 1-2; the details column keeps its live width
//     on track 3.
//
// The current session selection is client-local (persisted under
// `dsh.sessions.current`, no cross-tab live sync), so:
//
//   - the center panel listens for `storage` events and reloads itself when
//     the selection changes in another same-origin context (the launcher).
//     On reload the app rehydrates from localStorage and shows the newly
//     selected session;
//   - the sidebar panel polls `dsh.sessions.current` (the writing tab does
//     not receive its own storage event) and posts a message to the VS Code
//     webview host, which relays it to the extension so the editor tab opens
//     or comes to the front when the user picks a session.
//
// The marker below is used for idempotent patching and for capability
// detection (the extension probes the served index for it).
"use strict";

const PANEL_MARKER = "dsh-vscode-panel";

const PANEL_INJECT = `<!-- ${PANEL_MARKER} -->
<script>
(function () {
  var panel = new URLSearchParams(location.search).get('dshPanel');
  if (panel !== 'sidebar' && panel !== 'center') return;
  document.documentElement.setAttribute('data-dsh-panel', panel);
  var style = document.createElement('style');
  style.textContent =
    'html[data-dsh-panel="sidebar"] [class*="centerCol"],' +
    'html[data-dsh-panel="sidebar"] [class*="detailsCol"],' +
    'html[data-dsh-panel="sidebar"] [class$="_frame"] > [class$="_handle"]' +
      ' { display: none !important; }' +
    'html[data-dsh-panel="sidebar"] [class$="_frame"] { min-width: 1024px !important; }' +
    'html[data-dsh-panel="sidebar"] body { overflow: hidden !important; }' +
    'html[data-dsh-panel="center"] [class*="sidebarCol"],' +
    'html[data-dsh-panel="center"] [class$="_frame"] > [class$="_handle"][data-side="sidebar"]' +
      ' { display: none !important; }' +
    'html[data-dsh-panel="center"] [class*="centerCol"] { grid-column: 1 / 3 !important; }';
  document.head.appendChild(style);
  if (panel === 'center') {
    var seen = null;
    try { seen = localStorage.getItem('dsh.sessions.current'); } catch (e) {}
    window.addEventListener('storage', function (e) {
      if (e.key !== 'dsh.sessions.current' || e.newValue === seen) return;
      seen = e.newValue;
      location.reload();
    });
  } else {
    // Sidebar: tell the VS Code webview (and through it the extension) that
    // the user picked a session, so the editor tab opens or comes to the
    // front. The tab that wrote the key does not receive its own storage
    // event, so poll for the change.
    var last = null;
    try { last = localStorage.getItem('dsh.sessions.current'); } catch (e) {}
    setInterval(function () {
      var now = null;
      try { now = localStorage.getItem('dsh.sessions.current'); } catch (e) {}
      if (now !== last) {
        last = now;
        try { parent.postMessage({ source: 'dsh-vscode-panel', type: 'session-selected' }, '*'); } catch (e) {}
      }
    }, 400);
  }
})();
</script>`;

/**
 * Return `html` with the CURRENT split-panel adapter injected (replacing any
 * older injected block), or null when the document cannot carry it (no
 * `</head>`) or already carries exactly the current adapter.
 */
function injectPanelSupportHtml(html) {
  if (html.indexOf(PANEL_INJECT) >= 0) return null;
  let next = html;
  const markerAt = next.indexOf(`<!-- ${PANEL_MARKER} -->`);
  if (markerAt >= 0) {
    // Strip an OLDER injected block: the marker comment plus its script.
    const scriptAt = next.indexOf("<script>", markerAt);
    const scriptEnd = scriptAt >= 0 ? next.indexOf("</script>", scriptAt) : -1;
    if (scriptAt >= 0 && scriptEnd >= 0) {
      next = next.slice(0, markerAt) + next.slice(scriptEnd + "</script>".length);
    }
  }
  const headClose = next.indexOf("</head>");
  if (headClose < 0) return null;
  const result = next.slice(0, headClose) + PANEL_INJECT + "\n  " + next.slice(headClose);
  return result === html ? null : result;
}

module.exports = { PANEL_MARKER, PANEL_INJECT, injectPanelSupportHtml };
