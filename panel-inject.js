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
//   - sidebar: drop the center and details columns, hide the sidebar's own
//     collapse/expand toggle (the launcher is always expanded), and let the
//     sidebar column fill the iframe width so it tracks the VS Code sidebar
//     as the user drags its edge.
//   - center: drop the sidebar column (and its drag handle) and let the
//     conversation span tracks 1-2; the details column keeps its live width
//     on track 3. The sidebar column is kept in the DOM (off-screen, hidden,
//     inert) because the settings modal lives inside it; its overlay is
//     re-enabled so the modal covers the editor tab.
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
//     or comes to the front when the user picks a session;
//   - the settings trigger click is intercepted in the sidebar (the
//     launcher's own narrow modal stays closed), a localStorage flag is set,
//     and a message opens the editor tab; the center panel reacts to the
//     flag and clicks its own (hidden) settings trigger so the modal opens
//     in the wide editor tab.
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
    'html[data-dsh-panel="sidebar"] [class$="_frame"] > [class$="_handle"],' +
    // The dsh sidebar has a "收起侧边栏 / 展开侧边栏" toggle (class
    // hHd-Xa_toggle in 0.1.1-rc.2). In sidebar mode the extension owns
    // the rail, so hide every variant of the toggle.
    'html[data-dsh-panel="sidebar"] button[aria-label="收起侧边栏"],' +
    'html[data-dsh-panel="sidebar"] button[aria-label="展开侧边栏"],' +
    'html[data-dsh-panel="sidebar"] [class*="_toggle"] { display: none !important; }' +
    // The dsh AppFrame is a 3-column grid (sidebar | center | details)
    // with a hard min-width of 1024px and a fixed 280px sidebar column.
    // In sidebar mode the launcher is a single column that has to track
    // the VS Code sidebar's width: override the frame and the sidebar
    // column to fill 100% of the iframe. Also kill the min-width so a
    // narrow launcher (e.g. 200px) does not get a horizontal scrollbar.
    'html[data-dsh-panel="sidebar"] [class$="_frame"] {' +
      ' display: block !important;' +
      ' width: 100% !important;' +
      ' min-width: 0 !important;' +
      ' max-width: 100% !important;' +
      ' grid-template-columns: 100% !important;' +
    '}' +
    'html[data-dsh-panel="sidebar"] [class*="sidebarCol"] {' +
      ' width: 100% !important;' +
      ' min-width: 0 !important;' +
      ' max-width: 100% !important;' +
    '}' +
    'html[data-dsh-panel="sidebar"] body { overflow: hidden !important; }' +
    'html[data-dsh-panel="center"] [class*="sidebarCol"] {' +
      ' position: fixed !important; left: -10000px !important; top: 0 !important;' +
      ' width: 300px !important; height: 100% !important;' +
      ' overflow: visible !important;' +
      ' visibility: hidden !important; pointer-events: none !important; }' +
    'html[data-dsh-panel="center"] [class*="sidebarCol"] [class$="_overlay"] {' +
      ' position: fixed !important; inset: 0 !important;' +
      ' visibility: visible !important; pointer-events: auto !important; }' +
    // Settings popovers are React portals into the body, so they live in the
    // body's stacking context. The off-screen sidebar subtree (parent of the
    // settings panel) also competes at the body level via its z-index bump.
    // The popover's own z-index is 1100; without this rule the rows inside
    // the off-screen panel paint over the popover because the panel itself
    // creates a stacking context (z-index:1, position:relative) that is
    // taller than the sidebar's own z-index. Force the popover out of that
    // competition with a topmost z-index so the dropdown menu wins.
    'html[data-dsh-panel="center"] [role="menu"],' +
    'html[data-dsh-panel="center"] [role="listbox"],' +
    'html[data-dsh-panel="center"] [role="dialog"] {' +
      ' z-index: 2147483647 !important; }' + // also covers the nested delete-confirm dialog
    'html[data-dsh-panel="center"] [class$="_frame"] > [class$="_handle"][data-side="sidebar"]' +
      ' { display: none !important; }' +
    'html[data-dsh-panel="center"] [class*="centerCol"] { grid-column: 1 / 3 !important; }';
  document.head.appendChild(style);
  var settingsKey = 'dsh.vscode.panel.settings';
  var settingsTrigger = '[class$="_settingsArea"] button[aria-haspopup="dialog"]';
  if (panel === 'center') {
    var seen = null;
    try { seen = localStorage.getItem('dsh.sessions.current'); } catch (e) {}
    window.addEventListener('storage', function (e) {
      if (e.key !== 'dsh.sessions.current' || e.newValue === seen) return;
      seen = e.newValue;
      location.reload();
    });
    // Settings requested from the launcher: click the (hidden) settings
    // trigger so the modal opens here, in the wide editor tab.
    var openSettings = function () {
      var tries = 30;
      var attempt = function () {
        var t = document.querySelector(settingsTrigger);
        if (t) {
          try { localStorage.removeItem(settingsKey); } catch (e2) {}
          t.click();
          return;
        }
        if (--tries > 0) setTimeout(attempt, 300);
      };
      attempt();
    };
    window.addEventListener('storage', function (e) {
      if (e.key === settingsKey) openSettings();
    });
    try { if (localStorage.getItem(settingsKey) !== null) openSettings(); } catch (e) {}
  } else {
    // Sidebar: report session picks and settings requests to the VS Code
    // webview. The writing tab does not receive its own storage event, so
    // the session selection is polled; the settings click is intercepted at
    // capture time so the launcher's own narrow modal never opens.
    var last = null;
    try { last = localStorage.getItem('dsh.sessions.current'); } catch (e) {}
    var postSessionSelected = function () {
      try { parent.postMessage({ source: 'dsh-vscode-panel', type: 'session-selected' }, '*'); } catch (e) {}
    };
    setInterval(function () {
      var now = null;
      try { now = localStorage.getItem('dsh.sessions.current'); } catch (e) {}
      if (now !== last) {
        last = now;
        postSessionSelected();
      }
    }, 400);
    // The extension tells the launcher when the editor tab is closed so
    // the sidebar can drop the "currently selected" highlight. The center
    // (editor) panel is the writing side: when it goes away the sidebar
    // should not show any session as active — there is no conversation
    // panel open anywhere for the highlighted row to refer to.
    //
    // dsh always picks a default session on mount (the first one if
    // localStorage is empty) and writes that back to localStorage, so
    // clearing localStorage is a no-op — dsh restores it on the next
    // render. The only way to suppress the visual highlight without
    // rebuilding dsh is a CSS override scoped to a body class that the
    // launcher toggles on / off as the editor tab opens and closes.
    var noTabStyle = document.createElement('style');
    noTabStyle.id = 'dsh-no-tab';
    noTabStyle.textContent = 'html.dsh-no-tab [class*="sessionRow"][class*="selected"],' +
      ' html.dsh-no-tab [class*="sessionRow"][aria-selected="true"] {' +
      ' background: transparent !important;' +
      ' color: inherit !important;' +
      ' box-shadow: none !important;' +
      '}' +
      'html.dsh-no-tab [class*="sessionRow"][class*="selected"] [class*="title"],' +
      ' html.dsh-no-tab [class*="sessionRow"][class*="selected"] [class*="label"],' +
      ' html.dsh-no-tab [class*="sessionRow"][class*="selected"] [class*="name"] {' +
      ' color: inherit !important;' +
      ' font-weight: normal !important;' +
      '}';
    window.addEventListener('message', function (e) {
      var data = e.data;
      if (data === null || typeof data !== "object" || data.source !== 'dsh-vscode-host') return;
      if (data.type === 'session-closed') {
        try { localStorage.removeItem('dsh.sessions.current'); } catch (e2) {}
        last = null;
        // Apply the no-highlight override. dsh will keep its own
        // internal "current" pointer (and the editor-tab click path
        // will still match against it), but the sidebar no longer
        // paints it differently from the other rows.
        document.documentElement.classList.add('dsh-no-tab');
        if (!document.getElementById('dsh-no-tab')) {
          document.head.appendChild(noTabStyle);
        }
      } else if (data.type === 'session-opened') {
        // An editor tab is now showing a session — restore the real
        // highlight so the user can see which row is "current".
        document.documentElement.classList.remove('dsh-no-tab');
      }
    });
    document.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest(settingsTrigger) : null;
      if (t) {
        e.stopPropagation();
        e.preventDefault();
        try { localStorage.setItem(settingsKey, String(Date.now())); } catch (e2) {}
        try { parent.postMessage({ source: 'dsh-vscode-panel', type: 'settings-selected' }, '*'); } catch (e2) {}
        return;
      }
      // Every click on a session row (the treeitem under the sidebar) must
      // open the editor tab — including a click on the row that is already
      // selected. The polling above only fires when the localStorage value
      // actually changes, so an "already selected" re-click would be lost.
      // Here we capture the click before React handles it and re-emit a
      // session-selected message, then mirror dsh's own selection write
      // (best effort — if the sessionId can't be read from the row, we
      // still post the message so the editor tab comes to the front).
      var row = e.target && e.target.closest
        ? e.target.closest('[class*="sessionRow"][role="treeitem"]')
        : null;
      if (row) {
        // Skip if the user clicked an action button inside the row (rename,
        // delete, etc.) — those have their own handlers and we must not
        // also open the editor tab.
        var action = e.target && e.target.closest
          ? e.target.closest('[class*="rowActions"]')
          : null;
        if (!action) {
          // If dsh has stamped the row with a sessionId attribute, mirror
          // its future write so the 400 ms polling and any same-origin
          // storage listener stay consistent. When no attribute is set
          // (the current dsh build), just post the message — dsh's own
          // React onClick will write the new id to localStorage itself
          // a few milliseconds later, and the polling tick will pick
          // that up and post a second message. Either way the editor
          // tab opens; the duplicate is harmless.
          var sid = row.getAttribute('data-session-id') || row.getAttribute('data-id') || null;
          if (sid !== null) {
            try { localStorage.setItem('dsh.sessions.current', sid); last = sid; } catch (e3) {}
          }
          postSessionSelected();
        }
      }
    }, true);
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
