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
const DESKTOP_ROOT = path.join(os.homedir(), ".local", "share", "opencode-desktop-extensions");
const DESKTOP_EXT = path.join(DESKTOP_ROOT, "jbarevi");
/**
 * Where a replaced copy goes.
 *
 * NOT next to the live one. The desktop loader treats every subdirectory holding a
 * `manifest.json` as an extension and — for the app's own `oc://` window, which no
 * content-script match pattern can reach — concatenates ALL of their content scripts
 * into ONE page-world bundle. A backup kept beside the live copy therefore loads as a
 * second, older copy of this extension on every page: two engines on one composer, one
 * of them eating the keys while the other shows the badge. That is the "the badge says
 * -- INSERT -- but every key is a normal-mode command" report (2026-11-16).
 */
const RETIRED = path.join(os.homedir(), ".local", "state", "jsbarevi", "ships");
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
// The zip must be THIS version's. A carried-over zip from a previous release is worse than
// no zip at all, because it looks like the artifact you asked for.
const zipName = `jsbarevi-${pkg.version}.zip`;
const zip = fs.existsSync(path.join(DIST, zipName)) ? zipName : null;
console.log(`  manifest   ${manifest.version} (${manifest.version_name})`);
console.log(`  build      ${build.stamp ?? build.build ?? JSON.stringify(build).slice(0, 60)}`);
if (!zip) {
  console.error(`  zip        MISSING: dist/${zipName} was not produced`);
  process.exit(1);
}
console.log(`  zip        dist/${zip} (${(fs.statSync(path.join(DIST, zip)).size / 1024).toFixed(0)} KiB)`);

// 3. Sync the desktop extension directory: move the old one aside, copy the new one in.
if (sync) {
  if (!fs.existsSync(DESKTOP_EXT)) {
    console.log(`  desktop    ${DESKTOP_EXT} does not exist — not an OpenCode install? skipped`);
  } else {
    // Anything else named jbarevi* in that root is a copy the loader will ALSO load —
    // including every `<dir>.<timestamp>` a previous ship left behind. Move them out
    // first (never delete: they stay recoverable under RETIRED), or the app runs several
    // engines on the same field and the keystrokes go to whichever loaded first.
    const strays = fs.readdirSync(DESKTOP_ROOT)
      .filter((name) => /^jbarevi([.-]|$)/.test(name) && name !== "jbarevi")
      .map((name) => path.join(DESKTOP_ROOT, name))
      .filter((dir) => fs.existsSync(path.join(dir, "manifest.json")));
    if (strays.length) {
      fs.mkdirSync(RETIRED, { recursive: true });
      for (const dir of strays) {
        const target = path.join(RETIRED, path.basename(dir));
        fs.rmSync(target, { recursive: true, force: true });
        fs.renameSync(dir, target);
        console.log(`  retired    ${path.basename(dir)} -> ${target}  (a duplicate the loader would have run)`);
      }
    }

    const previous = fs.readFileSync(path.join(DESKTOP_EXT, "manifest.json"), "utf8");
    const previousVersion = JSON.parse(previous).version;
    const retired = path.join(RETIRED, `jbarevi.${new Date().toISOString().replace(/[:.]/g, "-")}`);
    fs.mkdirSync(RETIRED, { recursive: true });
    fs.renameSync(DESKTOP_EXT, retired);
    fs.mkdirSync(DESKTOP_EXT, { recursive: true });
    for (const entry of fs.readdirSync(DIST)) {
      if (NOT_AN_EXTENSION_FILE.has(entry) || entry.endsWith(".zip")) continue;
      fs.cpSync(path.join(DIST, entry), path.join(DESKTOP_EXT, entry), { recursive: true });
    }
    const after = JSON.parse(fs.readFileSync(path.join(DESKTOP_EXT, "manifest.json"), "utf8"));
    console.log(`  desktop    ${previousVersion} -> ${after.version}  (previous kept at ${retired})`);
    if (after.version !== pkg.version) {
      console.error("copy did not take: the desktop manifest still disagrees");
      process.exit(1);
    }
    // Verify the invariant, not the intention: the loader sees directories, so exactly
    // one of them may be ours after this run.
    const stillLoaded = fs.readdirSync(DESKTOP_ROOT)
      .filter((name) => /^jbarevi([.-]|$)/.test(name))
      .filter((name) => fs.existsSync(path.join(DESKTOP_ROOT, name, "manifest.json")));
    if (stillLoaded.length !== 1) {
      console.error(`  desktop    ${stillLoaded.length} loadable jbarevi directories in ${DESKTOP_ROOT}: ${stillLoaded.join(", ")}`);
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
