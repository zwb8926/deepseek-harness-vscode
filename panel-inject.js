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
//     The sidebar's own collapse/expand toggle (the rail chevron at the top
//     right) is hidden — the launcher is always expanded.
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
  // Always-on stacking-context fixes: dsh web's Modal container, the
  // settings overlay (VOzbGW_overlay), and the [role="dialog"] inside
  // Modal all use z-index values in the 1000–2147483647 range in the
  // bundle, so DOM order alone decides which one paints on top — fragile,
  // and it breaks depending on which element was mounted last.
  //
  // Fix: pin the modal layers to a fixed, stable priority by ARIA role:
  //   - [role="dialog"]          → z-index: 2000  (modal dialog content —
  //     confirmations, delete dialogs, etc. — TOPMOST layer)
  //   - body > [role="presentation"] → z-index: 1600 (the Modal portal
  //     container React appends to BODY; must sit ABOVE the off-screen
  //     sidebar column (1500) in center mode or the whole Modal subtree —
  //     including its inner dialog at 2000 — is covered by the settings
  //     panel)
  //   - [role="presentation"]    → z-index: 1000  (modal stage / overlay /
  //     mask container nested inside another layer — settings overlay,
  //     Modal root's children, etc.)
  // The dialog layer (2000) sits above the body-level Modal container
  // (1600), which sits above the settings panel layer (1500) which sits
  // above the editor content (≤1100): 编辑区 < settings面板 < Modal容器 <
  // deleteDialog.
  //
  // These rules are global (not gated on the dshPanel parameter) so that
  // dsh web opened directly in a browser (no split-panel) also gets the
  // same stable layering.
  var alwaysOn =
    // Modal dialog content (role="dialog"): confirmations, delete dialogs,
    // model pickers, etc. Topmost layer.
    '[role="dialog"]' +
      ' { z-index: 2000 !important; }' +
    // The Modal portal container React appends directly to BODY. It wraps
    // the dialog, so it must be above the off-screen sidebar column (1500)
    // in ?dshPanel=center — otherwise the whole Modal (dialog included) is
    // layered under the settings panel.
    'body > [role="presentation"]' +
      ' { z-index: 1600 !important; }' +
    // Modal stage / overlay / mask containers (role="presentation") nested
    // inside another layer (settings overlay, Modal root's mask, etc.).
    '[role="presentation"]' +
      ' { z-index: 1000 !important; }';
  var style = document.createElement('style');
  style.textContent = alwaysOn;
  document.head.appendChild(style);
  if (panel !== 'sidebar' && panel !== 'center') return;
  document.documentElement.setAttribute('data-dsh-panel', panel);
  var panelStyle = document.createElement('style');
  panelStyle.textContent =
    'html[data-dsh-panel="sidebar"] [class*="centerCol"],' +
    'html[data-dsh-panel="sidebar"] [class*="detailsCol"],' +
    'html[data-dsh-panel="sidebar"] [class$="_frame"] > [class$="_handle"],' +
    'html[data-dsh-panel="sidebar"] button:has([class$="_railMark"])' +
      ' { display: none !important; }' +
    'html[data-dsh-panel="sidebar"] [class$="_frame"] { min-width: 1024px !important; }' +
    'html[data-dsh-panel="sidebar"] body { overflow: hidden !important; }' +
    // The settings modal lives INSIDE the off-screen sidebar column. The
    // column's position:fixed creates its own stacking context (z-index:
    // auto — treated as 0 at the body level), so the always-on
    // role rules (presentation 1000 / dialog 2000) only order things
    // INSIDE that subtree: the settings panel loses to any body-level
    // layer the editor column paints (composer z:1, conversation panel
    // z:100, message-feedback note z:1100), i.e. the settings modal is
    // covered by the chat UI in the editor tab. Fix: lift the off-screen
    // sidebar column itself above the editor content (z-index 1500 —
    // above everything the center column paints, below the dialog layer
    // at 2000, so delete confirmations still cover the settings panel).
    'html[data-dsh-panel="center"] [class*="sidebarCol"] {' +
      ' position: fixed !important; left: -10000px !important; top: 0 !important;' +
      ' width: 300px !important; height: 100% !important;' +
      ' overflow: visible !important;' +
      ' visibility: hidden !important; pointer-events: none !important;' +
      ' z-index: 1500 !important; }' +
    'html[data-dsh-panel="center"] [class*="sidebarCol"] [class$="_overlay"] {' +
      ' position: fixed !important; inset: 0 !important;' +
      ' visibility: visible !important; pointer-events: auto !important; }' +
    // Settings popovers are React portals into the body, so they live in the
    // body's stacking context. The off-screen sidebar subtree (parent of the
    // settings panel) also competes at the body level via its z-index bump.
    // The popover's own z-index is 1100; without this rule the rows inside
    // the off-screen panel paint over the popover because the panel itself
    // creates a stacking context (z-index:1, position:relative) that is
    // taller than the sidebar's own z-index. Pin the popover to z-index:1
    // to match the panel — the always-on rules above already cover the
    // settings overlay and Modal; the menu/listbox popovers here get the
    // same treatment.
    // (The Modal-root [role="dialog"] rule is already injected above as
    // always-on; the menu/listbox rules below were the original set.)
    'html[data-dsh-panel="center"] [role="menu"],' +
    'html[data-dsh-panel="center"] [role="listbox"]' +
      ' { z-index: 1 !important; }' +
    'html[data-dsh-panel="center"] [class$="_frame"] > [class$="_handle"][data-side="sidebar"]' +
      ' { display: none !important; }' +
    'html[data-dsh-panel="center"] [class*="centerCol"] { grid-column: 1 / 3 !important; }';
  document.head.appendChild(panelStyle);
  var settingsKey = 'dsh.vscode.panel.settings';
  var settingsTrigger = '[class$="_settingsArea"] button[aria-haspopup="dialog"]';
  // The GUI persists its session selection under this key as a JSON snapshot
  // ({"sessionId":"...","subagentAddress":...}) written by its snapshot-store
  // middleware. A RAW session id breaks rehydration (JSON.parse throws), so
  // every read/write here goes through JSON — this was the "every click opens
  // a new session" bug: the app could not restore the pinned conversation.
  var currentKey = 'dsh.sessions.current';
  var idOf = function (raw) {
    if (raw === null) return null;
    try {
      var parsed = JSON.parse(raw);
      return parsed !== null && typeof parsed === 'object' && typeof parsed.sessionId === 'string' ? parsed.sessionId : null;
    } catch (e) { return null; }
  };
  var readCurrent = function () {
    try { return idOf(localStorage.getItem(currentKey)); } catch (e2) { return null; }
  };
  var writeCurrent = function (sessionId) {
    try { localStorage.setItem(currentKey, JSON.stringify({ sessionId: sessionId })); } catch (e3) {}
  };
  // Self-heal: older versions of this adapter wrote a RAW session id under
  // currentKey, which the GUI's snapshot-store cannot JSON.parse (it throws
  // and falls back to no session — the "every click opens a new session"
  // symptom). If the stored value is present but not a valid snapshot, drop
  // it so the GUI boots clean and the next write is a proper snapshot.
  try {
    var rawNow = localStorage.getItem(currentKey);
    if (rawNow !== null && idOf(rawNow) === null) localStorage.removeItem(currentKey);
  } catch (e4) {}
  if (panel === 'center') {
    // Pinned session: when the URL carries ?session=<id> (each editor tab
    // built by the native launcher tree pins one conversation), this frame
    // ALWAYS shows that conversation. It writes dsh.sessions.current on
    // load and then ignores storage changes / host session-selected
    // messages — otherwise every open tab would fight over the shared
    // localStorage and reload each other. With &seed=1 the selection is
    // written once too, but the frame KEEPS following the global selection
    // (used by the default/settings tab: it shows the last real session
    // instead of a stale blank new-session view). &openSettings=1 opens
    // the settings modal at boot (self-contained, no host message timing).
    //
    // This script runs in the head BEFORE the app bundle, so writing the
    // selection here is already in effect when the app boots — there is NO
    // reload needed (a reload would restart the whole cold boot and could
    // push the settings retry past its window).
    var qs = new URLSearchParams(location.search);
    var pinned = qs.get('session') || '';
    var isPinned = pinned !== '' && qs.get('seed') !== '1';
    var seen = readCurrent();
    if (pinned !== '' && seen !== pinned) {
      writeCurrent(pinned);
      seen = pinned;
    }
    window.addEventListener('storage', function (e) {
      if (e.key !== currentKey) return;
      var next = idOf(e.newValue);
      if (next === seen) return;
      if (isPinned) return; // pinned tabs ignore global selection changes
      seen = next;
      location.reload();
    });
    // Native-launcher bridge: the VS Code extension (which owns the new
    // TreeView sidebar now) posts { source: 'dsh-vscode-host', type:
    // 'session-selected', sessionId } to the editor iframe when the user
    // clicks a session in the native tree. Mirrors the sidebar's own
    // storage write so the editor shows the selected conversation.
    // 'open-settings' opens the settings modal in the editor tab.
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (d === null || typeof d !== 'object' || d.source !== 'dsh-vscode-host') return;
      if (d.type === 'session-selected' && typeof d.sessionId === 'string' && d.sessionId !== '' && !isPinned) {
        writeCurrent(d.sessionId);
        seen = d.sessionId;
        location.reload();
      } else if (d.type === 'open-settings') {
        openSettings();
      }
    });
    // Settings requested from the launcher: click the (hidden) settings
    // trigger so the modal opens here, in the wide editor tab. Idempotent:
    // if a settings dialog is already open, do nothing — the URL-param boot
    // and the fallback host message can both request it. The retry budget is
    // generous (30s) because a COLD webview panel boots the whole app
    // (bundle + plugins) and React renders the trigger late.
    var openSettings = function () {
      var tries = 100;
      var attempt = function () {
        if (document.querySelector('[role="dialog"]')) return; // already open
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
    // &openSettings=1: the settings tab asks for the settings modal directly
    // at boot — the extension no longer depends on the host-message bridge
    // (iframe-ready timing) for this.
    if (qs.get('openSettings') === '1') openSettings();
  } else {
    // Sidebar: report session picks and settings requests to the VS Code
    // webview. The writing tab does not receive its own storage event, so
    // the session selection is polled; the settings click is intercepted at
    // capture time so the launcher's own narrow modal never opens.
    var last = readCurrent();
    var postSessionSelected = function () {
      try { parent.postMessage({ source: 'dsh-vscode-panel', type: 'session-selected' }, '*'); } catch (e) {}
    };
    setInterval(function () {
      var now = readCurrent();
      if (now !== last) {
        last = now;
        postSessionSelected();
      }
    }, 400);
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
            writeCurrent(sid);
            last = sid;
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
