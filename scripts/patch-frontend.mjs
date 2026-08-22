// Build-time frontend patch: injects the split-panel adapter into the bundled
// dsh web frontend (node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html)
// so the vsix ships a GUI that supports ?dshPanel=sidebar|center.
//
// Runs from vscode:prepublish (after `tsc`). Idempotent: a patched file is
// skipped. Missing frontend (e.g. fresh clone without npm install) is a loud
// warning, not a hard failure — the runtime patch in DshManager covers it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { PANEL_MARKER, PANEL_INJECT } = require("../panel-inject.js");

const here = dirname(fileURLToPath(import.meta.url));
const indexFile = resolve(here, "..", "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist", "index.html");

if (!existsSync(indexFile)) {
  console.warn(`panel-inject: WARN frontend index.html not found at ${indexFile}`);
  console.warn("panel-inject: the vsix will rely on the runtime patch (DshManager.ensurePanelSupport)");
  process.exit(0);
}

const html = readFileSync(indexFile, "utf8");
if (html.includes(PANEL_MARKER)) {
  console.log("panel-inject: frontend already patched, skipping");
  process.exit(0);
}
if (!html.includes("</head>")) {
  console.warn(`panel-inject: WARN ${indexFile} has no </head>; refusing to patch`);
  process.exit(0);
}

writeFileSync(indexFile, html.replace("</head>", `${PANEL_INJECT}\n  </head>`));
console.log(`panel-inject: patched ${indexFile}`);
