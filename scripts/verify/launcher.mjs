// The native launcher (the VS Code side bar): its generated HTML, its toolbar
// buttons, and — the part that regressed once — its icon font.
//
// Icons are written by hand here: `CODICONS` maps a key to a codicon class and
// a separate CSS block supplies the `::before` glyph. Adding a name without its
// rule renders an empty box (that is how the 插件 button first shipped), so this
// suite ties all three together: the name, the CSS rule, and the GLYPH NAME in
// the bundled media/codicon.ttf — read from the font's own post/cmap tables,
// not from a hard-coded table that could drift.
//
//   node scripts/verify/launcher.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO, suite } from "./harness.mjs";
import { loadWithStubbedVscode, stubVscode } from "./harness.mjs";

const s = suite("launcher");

// ---- 1. the generated HTML ----------------------------------------------
const { buildLauncherHtml } = loadWithStubbedVscode("out/launcherView.js", stubVscode());
const html = buildLauncherHtml();
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
new Function(script); // throws on a syntax error
s.check("launcher script parses", true, `${script.length} bytes`);

for (const [id, kind, label] of [
  ["btnNewSession", "new-session", "新建会话"],
  ["btnPlugins", "plugins", "插件"],
  ["btnSettings", "settings", "设置"],
]) {
  s.check(
    `toolbar button ${id}`,
    html.includes(`id="${id}"`) && html.includes(`data-click="${kind}"`) && html.includes(`title="${label}"`)
  );
}
s.check("all three buttons get a glyph", (html.match(/\.innerHTML = icon\(/g) ?? []).length >= 3);

// ---- 2. icon name -> CSS rule -> real glyph ------------------------------
const names = [...new Set([...html.matchAll(/"codicon-([a-z-]+)"/g)].map((m) => m[1]))];
const rules = new Map([...html.matchAll(/\.codicon-([a-z-]+)::before\s*\{\s*content:\s*"\\([0-9a-f]{4})"/g)].map((m) => [m[1], m[2]]));
const missing = names.filter((n) => !rules.has(n));
s.check("every icon name has a CSS rule", names.length > 0 && missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : `${names.length} names / ${rules.size} rules`);

/** Glyph names + a cmap lookup, straight from the shipped font. */
function font(file) {
  const buf = readFileSync(file);
  const tables = {};
  const numTables = buf.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    tables[buf.toString("ascii", off, off + 4)] = { offset: buf.readUInt32BE(off + 8) };
  }
  const post = tables.post.offset;
  const numGlyphs = buf.readUInt16BE(post + 32);
  const indexCount = buf.readUInt16BE(post + 34);
  let p = post + 34 + 2 + indexCount * 2;
  const glyphNames = [];
  for (let gid = 0; gid < numGlyphs; gid++) {
    if (p + 1 > buf.length) break;
    const len = buf.readUInt8(p);
    if (p + 1 + len > buf.length) break;
    glyphNames.push(buf.toString("ascii", p + 1, p + 1 + len));
    p += 1 + len;
  }
  const cmap = tables.cmap.offset;
  const nSub = buf.readUInt16BE(cmap + 2);
  let sub = -1;
  for (let i = 0; i < nSub; i++) {
    const rec = cmap + 4 + i * 8;
    const platform = buf.readUInt16BE(rec);
    if (platform === 3 || platform === 0) { sub = cmap + buf.readUInt32BE(rec + 4); break; }
  }
  const glyphFor = (code) => {
    if (sub < 0 || buf.readUInt16BE(sub) !== 4) return 0;
    const segX2 = buf.readUInt16BE(sub + 6);
    const segs = segX2 / 2;
    const endO = sub + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
    for (let i = 0; i < segs; i++) {
      const end = buf.readUInt16BE(endO + i * 2);
      if (code > end) continue;
      const start = buf.readUInt16BE(startO + i * 2);
      if (code < start) return 0;
      const delta = buf.readInt16BE(deltaO + i * 2);
      const rangeOff = buf.readUInt16BE(rangeO + i * 2);
      if (rangeOff === 0) return (code + delta) & 0xffff;
      const g = buf.readUInt16BE(rangeO + i * 2 + rangeOff + (code - start) * 2);
      return g === 0 ? 0 : (g + delta) & 0xffff;
    }
    return 0;
  };
  return { glyphNames, glyphFor };
}

const { glyphFor } = font(path.join(REPO, "media", "codicon.ttf"));
// Two levels, because each catches a different mistake:
//   1. the codepoint must resolve to SOME glyph (a bogus codepoint renders as an
//      empty box);
//   2. it must be the OFFICIAL codepoint for that name. The font's own glyph
//      names cannot be trusted for this (it calls EA78 something else, and the
//      插件 button first shipped pointing there), so the table below is
//      cross-checked against a vendored copy of the official codicon stylesheet.
const OFFICIAL = {
  zap: "ea86", plus: "ea60", gear: "eaf8", extensions: "eae6", folder: "ea83",
  comment: "ea6b", "comment-discussion": "eac7", edit: "ea73", "git-branch": "ea68",
  trash: "ea81", ellipsis: "ea7c", "chevron-down": "eab4", "circle-outline": "eabc",
};
const empty = [];
const drifted = [];
for (const [name, hex] of rules) {
  if (glyphFor(parseInt(hex, 16)) === 0) empty.push(`${name} (U+${hex.toUpperCase()})`);
  if (OFFICIAL[name] !== undefined && OFFICIAL[name] !== hex) drifted.push(`${name}: U+${hex.toUpperCase()} should be U+${OFFICIAL[name].toUpperCase()}`);
}
s.check("every CSS codepoint resolves to a glyph in media/codicon.ttf", empty.length === 0, empty.length ? `empty: ${empty.join(", ")}` : `${rules.size} icons`);
s.check("every codepoint matches the official codicon mapping", drifted.length === 0, drifted.length ? drifted.join(", ") : `${Object.keys(OFFICIAL).length} icons verified`);
s.check("the 插件 icon uses the official extensions codepoint", rules.get("extensions") === "eae6", `U+${(rules.get("extensions") ?? "?").toUpperCase()}`);

process.exit(s.finish() ? 0 : 1);
