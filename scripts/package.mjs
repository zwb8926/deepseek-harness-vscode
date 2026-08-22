// Build a vsix whose output filename matches the version in package.json
// (the version follows the release branch: 2026.8.22, 2026.8.22-1, …).
//
// `vsce package` always runs `vscode:prepublish` first, which here means
// `npm run compile && npm run patch-frontend`. So the bundled dsh-web-
// frontend is patched to the current panel-inject before the archive is
// written. We then shell out to `npx @vscode/vsce package` and rename the
// output to `<displayName slug>-<version>.vsix`.
import { execSync } from "node:child_process";
import { readFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
process.chdir(root);

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const version = pkg.version;
if (typeof version !== "string" || version === "") {
  throw new Error("package.json is missing a version field");
}

// Display-name slug → "DSH-for-VS-Code" (matches the historical name).
// We hard-code the slug because the displayName has spaces; the marketplace
// identifier is the `name` field ("deepseekharness-for-vscode"), and the
// on-disk filename has been the DSH-for-VS-Code-* form since 2026.8.22.
const slug = "DSH-for-VS-Code";
const out = `${slug}-${version}.vsix`;
const staging = `__staging-${version}.vsix`;

console.log(`[package] version=${version} → ${out}`);

execSync(
  `npx --yes @vscode/vsce package --out "${staging}"`,
  { stdio: "inherit" }
);

if (existsSync(out)) unlinkSync(out);
renameSync(staging, out);
console.log(`[package] wrote ${out}`);
