// Inspect the iframe sidebar (?dshPanel=sidebar) DOM structure to mimic its
// list layout: what rows look like, their text/order and grouping.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const userDataDir = path.join(process.env.TEMP || "C:\\Users\\zwb89\\AppData\\Local\\Temp", "chrome-sb-" + Date.now());
fs.mkdirSync(userDataDir, { recursive: true });

const proc = spawn(chromePath, [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
  "--window-size=380,900",
  "--user-data-dir=" + userDataDir, "--remote-debugging-port=9233",
  "http://127.0.0.1:3080/?dshPanel=sidebar&v=" + Date.now()
], { stdio: ["ignore", "pipe", "pipe"] });

setTimeout(async () => {
  try {
    const tabsRes = await fetch("http://127.0.0.1:9233/json");
    const tabs = await tabsRes.json();
    const tab = tabs.find((t) => t.url.includes("dshPanel=sidebar")) || tabs[0];
    const ws = new (require("ws"))(tab.webSocketDebuggerUrl);
    await new Promise((r) => ws.on("open", r));
    let id = 1;
    const send = (method, params) => {
      const msg = { id: id++, method, params };
      return new Promise((resolve) => {
        const h = (data) => { const m = JSON.parse(data.toString()); if (m.id === msg.id) { ws.off("message", h); resolve(m.result); } };
        ws.on("message", h);
        ws.send(JSON.stringify(msg));
      });
    };
    await send("Runtime.enable");
    await new Promise((r) => setTimeout(r, 6000));

    const insp = `
      (function(){
        // The sidebar column structure: find the session list rows & workspace rows
        const rows = [...document.querySelectorAll('[class*="sessionRow"], [class*="sessionRowSearch"], [class*="Workspace"], [class*="workspaceRow"], [role="treeitem"]')];
        const info = rows.slice(0, 20).map((el) => ({
          cls: String(el.className).slice(0, 60),
          text: (el.textContent||'').trim().slice(0, 80).replace(/\\s+/g, ' '),
          role: el.getAttribute('role'),
          ariaSel: el.getAttribute('aria-selected')
        }));
        // Top area: any new-session buttons / headings?
        const btns = [...document.querySelectorAll('[class*="sidebarCol"] button')].slice(0, 12).map((b) => ({
          cls: String(b.className).slice(0, 50),
          text: (b.textContent||'').trim().slice(0, 40) || b.getAttribute('aria-label') || b.getAttribute('data-tip') || ''
        }));
        // Section headings (h2/h3/h4 or group labels)
        const heads = [...document.querySelectorAll('[class*="sidebarCol"] h2, [class*="sidebarCol"] h3, [class*="sidebarCol"] h4, [class*="sidebarCol"] [class*="groupHead"]')].slice(0, 10).map((h) => (h.textContent||'').trim().slice(0, 40));
        return { rows: info, buttons: btns, headings: heads };
      })();
    `;
    const r = await send("Runtime.evaluate", { expression: insp, returnByValue: true });
    console.log("SIDEBAR:", JSON.stringify(r.result.value, null, 2));
    ws.close();
  } catch (e) {
    console.log("ERROR:", e.message);
  } finally {
    proc.kill();
    setTimeout(() => process.exit(0), 500);
  }
}, 4000);
