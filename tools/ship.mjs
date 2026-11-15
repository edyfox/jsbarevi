#!/usr/bin/env node
/**
 * Ship: build the package and install it into the homes that load it from disk.
 *
 *     node tools/ship.mjs               # build + sync the OpenCode desktop extension
 *     node tools/ship.mjs --no-sync     # build (and the zip) only
 *     node tools/ship.mjs --lark        # …and rebuild the Lark payload, print the patch
 *
 * Why this exists: the same three steps (build, zip, copy into the desktop's extension
 * directory) were done by hand four times, and hand-copies drift — one of them left a
 * stale `content.js` next to an updated `manifest.json`, which reads as "the new feature
 * does not work" rather than as a bad copy.
 *
 * What it does NOT do: restart anything. The desktop app loads the extension into its
 * persistent session at startup, and the Lark seam is an asar patch that needs Lark
 * closed. Both are printed at the end instead of guessed at.
 *
 * Recovery: the previous copy of the extension directory is MOVED aside, never deleted
 * (`<dir>.<timestamp>`), so a bad ship is one `mv` from undone.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const DESKTOP_EXT = path.join(os.homedir(), ".local", "share", "opencode-desktop-extensions", "jbarevi");
// Built for Lark's page world, not part of a browser extension.
const NOT_AN_EXTENSION_FILE = new Set(["lark-payload.js"]);

const args = process.argv.slice(2);
const sync = !args.includes("--no-sync");
const lark = args.includes("--lark");

function run(file, argv, opts = {}) {
  execFileSync(file, argv, { cwd: ROOT, stdio: "inherit", ...opts });
}

function stamp(msg) {
  console.log(`\x1b[1m${msg}\x1b[0m`);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
stamp(`ship jsbarevi ${pkg.version}`);

// 1. Build (the packager stamps the build id, substitutes the manifest version, and
//    writes dist/ + the Web Store zip).
run(process.execPath, [path.join(ROOT, "tools", "build-extension.mjs")]);

// 2. Verify what was built, not what we intended to build.
const manifest = JSON.parse(fs.readFileSync(path.join(DIST, "manifest.json"), "utf8"));
if (manifest.version !== pkg.version) {
  console.error(`manifest version ${manifest.version} != package ${pkg.version}`);
  process.exit(1);
}
const build = JSON.parse(fs.readFileSync(path.join(DIST, "build.json"), "utf8"));
const zip = fs.readdirSync(DIST).find((f) => f.endsWith(".zip"));
console.log(`  manifest   ${manifest.version} (${manifest.version_name})`);
console.log(`  build      ${build.stamp ?? build.build ?? JSON.stringify(build).slice(0, 60)}`);
console.log(`  zip        ${zip ? path.join("dist", zip) : "MISSING"}`);

// 3. Sync the desktop extension directory: move the old one aside, copy the new one in.
if (sync) {
  if (!fs.existsSync(DESKTOP_EXT)) {
    console.log(`  desktop    ${DESKTOP_EXT} does not exist — not an OpenCode install? skipped`);
  } else {
    const previous = fs.readFileSync(path.join(DESKTOP_EXT, "manifest.json"), "utf8");
    const previousVersion = JSON.parse(previous).version;
    const retired = `${DESKTOP_EXT}.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.renameSync(DESKTOP_EXT, retired);
    fs.mkdirSync(DESKTOP_EXT, { recursive: true });
    for (const entry of fs.readdirSync(DIST)) {
      if (NOT_AN_EXTENSION_FILE.has(entry) || entry.endsWith(".zip")) continue;
      fs.cpSync(path.join(DIST, entry), path.join(DESKTOP_EXT, entry), { recursive: true });
    }
    const after = JSON.parse(fs.readFileSync(path.join(DESKTOP_EXT, "manifest.json"), "utf8"));
    console.log(`  desktop    ${previousVersion} -> ${after.version}  (previous kept at ${path.basename(retired)})`);
    if (after.version !== pkg.version) {
      console.error("copy did not take: the desktop manifest still disagrees");
      process.exit(1);
    }
  }
}

// 4. Lark's payload is a different artifact (page world, no extension machinery).
if (lark) {
  run(process.execPath, [path.join(ROOT, "tools", "lark-payload.mjs")]);
  console.log(`  lark       payload rebuilt: dist/lark-payload.js`);
}

stamp("next");
if (sync) console.log("  · restart the OpenCode desktop app (the extension loads at startup, into its persistent session)");
if (lark) {
  // The env var is not optional: without it the installer assembles the LEGACY Input Vim
  // payload and quietly skips ours ("no Input Vim extension ... this path assembles the
  // legacy payload"), which reads as a successful no-op.
  console.log("  · close Lark, then:");
  console.log(`      LARK_PAYLOAD_FROM=${path.join(ROOT, "dist", "lark-payload.js")} \\`);
  console.log("        ../../_local/bin/lark-ext-patch patch        (then reopen Lark)");
}
console.log("  · Chromebook / other Chrome: chrome://extensions → Developer mode → Load unpacked → dist/");
