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
//     breakpoint (the GUI auto-collapses below 1024px — SIDEBAR_AUTO_COLLAPSE)
//     so the sidebar renders expanded instead of collapsing to the 56px rail
//     in a narrow viewport. The rail expand/collapse control is hidden — the
//     launcher is always expanded.
//   - center: the editor tab is the conversation only. The GUI's own sidebar
//     column is suppressed there (it duplicates the VS Code launcher, which
//     lists the same sessions), and the conversation spans tracks 1-2 so the
//     hidden strip costs no width. The column itself is NOT removed from the
//     DOM: rc.1 mounts the settings trigger AND its modal inside that subtree
//     (slot `sidebar.settings`), so dropping the element would take the
//     settings dialog with it. Painting is suppressed instead — `visibility`
//     rather than `display`, which keeps the subtree laid out, keeps the
//     trigger clickable through `.click()`, and lets the dialog layer opt back
//     in (see the `_overlay` / `[role="dialog"]` rules below).
//
// Frontend versions. The adapter was written against the 0.1.2-alpha.2 DOM
// and still matches 0.1.5-alpha.2: the AppFrame source is unchanged across
// alpha.2 / rc.1 / alpha.2-of-0.1.5 (three-column grid with inline
// `grid-template-columns`, drag handles with `data-side`, column CSS-module
// locals frame/sidebarCol/centerCol/frame/handle/overlayLayer). 0.1.5 renamed
// two things the rules below care about: the third column is now the RIGHT BAR
// (local `rightbarCol`, was `detailsCol`) and the centre slot is `main` (was
// `conversation`) — the adapter matches both column names, so one injected
// copy serves either frontend. The settings trigger and its dialog are still
// rendered inside the sidebar subtree (`sidebar.settings`), so centre mode
// still has to keep that column in the DOM. CSS-module class names are
// minified to a `<hash>_<local>` token (e.g. `pI_x6G_centerCol`), so every
// rule matches on the stable `_<local>` SUFFIX / substring rather than a full
// class name.
// Each UI plugin ships as its own runtime bundle that injects its
// stylesheet via a `<style data-plugin-css>` tag (they are NOT in the shell
// assets — searching only `assets/index-*.js` for `sidebarCol` etc. finds
// nothing and is the wrong place to look). The layout classes exist only
// once the plugin bundle runs, so this script applies its rules with
// !important and lets React mount underneath them.
//
// The current session selection is client-local (persisted under
// `dsh.sessions.current` by the session-controller snapshot store — 0.1.5
// keeps the same key and payload, so the coordination below is unchanged), so:
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
  // Clipboard shim (before the app bundle): inside a VS Code webview the
  // nested iframe's permissions-policy chain denies navigator.clipboard
  // writes ("Write permission denied"), and the dsh app's copy helper treats
  // a rejected writeText as a silent failure (its execCommand fallback only
  // runs when the clipboard API is ABSENT). Shim writeText so a denied
  // native write falls back to the classic textarea + execCommand('copy')
  // path, which is not policy-gated and works under a user click.
  try {
    var __dshClip = navigator.clipboard;
    if (__dshClip && typeof __dshClip.writeText === 'function') {
      var __dshNativeWrite = __dshClip.writeText.bind(__dshClip);
      __dshClip.writeText = function (text) {
        var textStr = String(text);
        var fallback = function () {
          try {
            var ta = document.createElement('textarea');
            ta.value = textStr;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            var ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return ok === true;
          } catch (e2) { return false; }
        };
        return new Promise(function (resolve) {
          var settled = false;
          try {
            __dshNativeWrite(textStr).then(function () {
              if (!settled) { settled = true; resolve(true); }
            }, function () {
              if (!settled) { settled = true; resolve(fallback()); }
            });
          } catch (e3) {
            if (!settled) { settled = true; resolve(fallback()); }
          }
        });
      };
    }
  } catch (e4) { /* clipboard unavailable — leave as-is */ }
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
    //
    // The dockkit tab strip is exempt: from 0.1.5 the shell renders it with
    // role="presentation" too, and because z-index applies to a flex/grid item
    // even when it is not positioned, this blanket pin would give an ordinary
    // in-flow strip a stacking context at 1000 — i.e. above its own panes.
    '[role="presentation"]:not([data-dockkit-strip-tabs])' +
      ' { z-index: 1000 !important; }';
  var style = document.createElement('style');
  style.textContent = alwaysOn;
  document.head.appendChild(style);
  if (panel !== 'sidebar' && panel !== 'center') return;
  document.documentElement.setAttribute('data-dsh-panel', panel);
  // The AppFrame grid owns the three columns. Other rc.1 UI modules reuse the
  // CSS-module local name "_frame" (attachment/chat/subagent/user-questions
  // frames), so the frame-anchored rules below scope to the LAYOUT frame —
  // the one whose direct children include the sidebar column.
  var frameSel = '[class$="_frame"]:has(> [class*="sidebarCol"])';
  // Center-mode handles. centerSidebar is the GUI's own sidebar column; the
  // settings dialog lives inside it, so the column is suppressed by PAINTING
  // and kept in place: display:none would unmount the dialog, and the older
  // off-screen treatment (position:fixed + visibility:hidden on the column,
  // with only its overlay re-enabled) is the one that left rc.1's settings
  // dialog unusable and got deleted in 2026.9.4 — a column that stays in the
  // grid flow needs no such escape hatch.
  var centerSidebar = 'html[data-dsh-panel="center"] ' + frameSel + ' > [class*="sidebarCol"]';
  // The settings modal (rc.1: a <hash>_overlay carrying the
  // <hash>_panel[role="dialog"]) is a fixed full-viewport layer rendered in
  // that subtree — it opts back into visibility, as does any dialog that ever
  // renders there.
  var centerOverlay = centerSidebar + ' [class$="_overlay"]:has([role="dialog"])';
  var centerDialog = centerSidebar + ' [role="dialog"]';
  var panelStyle = document.createElement('style');
  panelStyle.textContent =
    // The third column is the details column up to 0.1.2 (detailsCol) and the
    // right bar from 0.1.5 on (rightbarCol) — the adapter is injected into
    // whatever frontend the server serves, so it matches both.
    'html[data-dsh-panel="sidebar"] [class*="centerCol"],' +
    'html[data-dsh-panel="sidebar"] [class*="detailsCol"],' +
    'html[data-dsh-panel="sidebar"] [class*="rightbarCol"],' +
    'html[data-dsh-panel="sidebar"] [class$="_handle"],' +
    'html[data-dsh-panel="sidebar"] button:has([class$="_railMark"])' +
      ' { display: none !important; }' +
    'html[data-dsh-panel="sidebar"] ' + frameSel + ' { min-width: 1024px !important; }' +
    'html[data-dsh-panel="sidebar"] body { overflow: hidden !important; }' +
    // Center: paint nothing of the sidebar column (rail, session list, its
    // footer) and everything inside it, except a dialog layer.
    centerSidebar + ',' + centerSidebar + ' * { visibility: hidden !important; }' +
    centerOverlay + ',' + centerOverlay + ' *,' +
    centerDialog + ',' + centerDialog + ' * { visibility: visible !important; }' +
    // The (invisible) column stays a grid item, so it can also lift the
    // settings dialog above the conversation's own layers (composer z:1,
    // conversation z:100, feedback note z:1100) while staying under the
    // body-level Modal container the always-on rules pin at 1600:
    // 编辑区 < settings面板 < Modal容器 < deleteDialog.
    //
    // Both columns are placed EXPLICITLY, in row 1: the frame is a one-row
    // grid whose tracks come from an inline grid-template-columns, so
    // auto-placement is the trap here. Left auto, the hidden column is pushed
    // past the explicitly placed conversation (into the details track), and a
    // bare grid-column: 1 / 3 on the conversation sends it to an implicit
    // SECOND row (measured: y = frame height, height 0). With both pinned,
    // the details column keeps auto-placing into its own track 3.
    centerSidebar + ' { position: relative !important; z-index: 1500 !important;' +
      ' grid-area: 1 / 1 / 2 / 2 !important; }' +
    'html[data-dsh-panel="center"] ' + frameSel + ' > [class*="centerCol"]' +
      ' { grid-area: 1 / 1 / 2 / 3 !important; }' +
    'html[data-dsh-panel="center"] ' + frameSel + ' > [class$="_handle"][data-side="sidebar"]' +
      ' { display: none !important; }';
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
    // True only when the SETTINGS modal is on screen. Testing for any
    // [role="dialog"] is not enough: other dialogs (the pre-release notice, the
    // workspace picker, …) also carry that role and can stay mounted after
    // being dismissed — which made every later settings click a no-op, i.e.
    // "close the settings dialog once and the button stops working". The
    // settings modal is the one holding the settings nav list.
    var settingsDialogOpen = function () {
      var dialogs = document.querySelectorAll('[role="dialog"]');
      for (var i = 0; i < dialogs.length; i++) {
        if (dialogs[i].querySelector('[class*="_navTitle"], [class*="_navCell"], [class*="_navList"]')) return true;
      }
      return false;
    };
    // Settings requested from the launcher: click the (hidden) settings
    // trigger so the modal opens here, in the wide editor tab. Idempotent:
    // if the settings dialog is already open, do nothing — the URL-param boot
    // and the fallback host message can both request it. The retry budget is
    // generous (30s) because a COLD webview panel boots the whole app
    // (bundle + plugins) and React renders the trigger late.
    var openSettings = function () {
      var tries = 100; // the trigger is not rendered yet during a cold boot
      var clicks = 0; // bounded: never toggle a slow-opening modal shut
      var attempt = function () {
        if (settingsDialogOpen()) return; // already open
        var t = document.querySelector(settingsTrigger);
        if (t === null) {
          if (--tries > 0) setTimeout(attempt, 300);
          return;
        }
        try { localStorage.removeItem(settingsKey); } catch (e2) {}
        if (clicks >= 2) return;
        clicks++;
        t.click();
        // Verify: a click fired right after a close can land while React is
        // still tearing the previous tree down. attempt() re-checks the
        // settings dialog before clicking again, so a merely SLOW open is never
        // toggled shut.
        setTimeout(attempt, 1200);
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
