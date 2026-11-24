#!/usr/bin/env node
// Package the extension.
//
// Why a build step at all: a Chrome content script is a CLASSIC script, and
// Electron hosts that load this extension inject the same file as one concatenated
// bundle into a page world where `import()` cannot reach the extension at all. One
// file, no module loader, no runtime resolution — the engine is inlined.
//
// What it does NOT do: transform or rewrite the engine. Everything the browser runs
// is `src/` as written (plus `extension/src`), concatenated by esbuild. The store
// package and the page fixture therefore run the same code.
//
//   node tools/build-extension.mjs              # dist/ + dist/zip
//   node tools/build-extension.mjs --no-zip
//   node tools/build-extension.mjs --out <dir>

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { currentBuild } from "./build-id.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.join(ROOT, "extension");

const args = process.argv.slice(2);
const noZip = args.includes("--no-zip");
const outArg = args.indexOf("--out");
const OUT = path.resolve(ROOT, outArg >= 0 ? args[outArg + 1] : "dist");

// The store caps the description at 132 characters; a silent overrun is a rejected
// upload, so it is checked here rather than discovered in the dashboard.
const DESCRIPTION = "Traditional vi keys in any text field: NORMAL, VISUAL and INSERT "
  + "modes, operators, text objects, registers and ex commands.";

function fail(message) {
  console.error(`build-extension: ${message}`);
  process.exit(1);
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  if (DESCRIPTION.length > 132) fail(`description is ${DESCRIPTION.length} chars, the store allows 132`);

  // The stamp must describe the code being packaged right now. A stamp written
  // before the last commit describes the previous one — the exact stale label the
  // label exists to prevent (see docs/ENGINE.md, "an instrument that can go stale").
  execFileSync(process.execPath, [path.join(ROOT, "tools", "stamp-build.mjs")], { cwd: ROOT, stdio: "inherit" });
  const build = currentBuild({ cwd: ROOT });
  const versionName = `${pkg.version}+${build.stamp}`;

  // Artifacts that OTHER tools put in dist/ are not this build's to delete. `--no-zip` is
  // used by test:ext and by the Lark payload builder (which bundles into a temp dir), and
  // wiping the whole directory silently removed the Web Store zip `npm run ship` had just
  // produced — the symptom was "the zip is not where you said it is" after a successful
  // ship. They are carried across; a stale one is caught by the version in its filename
  // and by ship, which rebuilds both.
  const carriedArtifact = /(\.zip$|^lark-payload\.js$)/;
  const carried = fs.existsSync(OUT)
    ? fs.readdirSync(OUT)
      .filter((f) => carriedArtifact.test(f))
      .map((f) => [f, fs.readFileSync(path.join(OUT, f))])
    : [];
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const banner = `/* jsbarevi ${versionName} — built ${new Date().toISOString()}\n`
    + ` * one classic script: the engine (src/) bundled for a content script.\n`
    + ` * source: https://github.com/edyfox/jsbarevi — MIT */`;

  // ONE ENGINE PER DOCUMENT.
  //
  // This file can arrive twice in ONE JS scope, and a second copy is not harmless. The
  // concrete host is OpenCode desktop: its loader concatenates the content scripts of
  // every directory under `opencode-desktop-extensions/` into a single page-world
  // bundle for its own `oc://` window. A retired copy of this extension sitting next to
  // the current one therefore installs a SECOND engine on the composer: two `active`
  // maps, two key dispatchers, two badges. The first-registered dispatcher eats every
  // key (it calls `stopImmediatePropagation`), while the badge on screen belongs to
  // another copy — which reads exactly as "-- INSERT --, but every key is a normal-mode
  // command, I cannot type".
  //
  // The duplicate is a packaging error (two copies of one extension in one scope), and
  // its consequence must not be a second editor: the first copy owns the document and
  // everything after it stands down. The guard is generated here, not written in
  // `extension/src/content.js`, because it is a property of the ARTIFACT — every path
  // that can deliver this bundle (content script, oc:// injection, Lark payload) goes
  // through this packager, and an ESM module cannot bail out of its own body.
  const ONCE = "jsbareviContentLoaded";
  const onceGuard = {
    banner: {
      js: `${banner}\nif (globalThis.${ONCE}) {\n`
        + `  try { console.warn("[jsbarevi] a second copy of this script was loaded into the same page; the first copy owns it (duplicate extension directories?). This copy stands down."); } catch (e) {}\n`
        + `} else {\n  globalThis.${ONCE} = true;`,
    },
    footer: { js: "\n}" },
  };

  await esbuild.build({
    entryPoints: [path.join(EXT, "src", "content.js")],
    outfile: path.join(OUT, "content.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome110"],
    charset: "utf8",
    legalComments: "none",
    ...onceGuard,
    logLevel: "warning",
  });

  // The MAIN-world Escape blocker: its own file, because a content script's world
  // cannot patch the page's HTMLElement.prototype.
  await esbuild.build({
    entryPoints: [path.join(EXT, "src", "escape-blocker.js")],
    outfile: path.join(OUT, "escape-blocker.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome110"],
    charset: "utf8",
    legalComments: "none",
    banner: { js: banner },
    logLevel: "warning",
  });

  await esbuild.build({
    entryPoints: [path.join(EXT, "src", "background.js")],
    outfile: path.join(OUT, "background.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome110"],
    charset: "utf8",
    legalComments: "none",
    banner: { js: banner },
    logLevel: "warning",
  });

  for (const file of ["popup.html", "popup.css", "popup.js"]) {
    fs.copyFileSync(path.join(EXT, file), path.join(OUT, file));
  }
  fs.cpSync(path.join(EXT, "icons"), path.join(OUT, "icons"), { recursive: true });

  const manifest = fs.readFileSync(path.join(EXT, "manifest.json"), "utf8")
    .replace("__VERSION__", pkg.version)
    .replace("__VERSION_NAME__", versionName)
    .replace("__DESCRIPTION__", DESCRIPTION);
  const parsed = JSON.parse(manifest);
  if (parsed.version !== pkg.version) fail("manifest version did not substitute");
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(parsed, null, 2) + "\n");

  // :version and the popup read these; one file, so the two cannot disagree.
  fs.writeFileSync(path.join(OUT, "build.json"), JSON.stringify({
    version: pkg.version,
    version_name: versionName,
    stamp: build.stamp,
    built_at: new Date().toISOString(),
  }, null, 2) + "\n");

  // A classic script has no import statements. If a refactor reintroduces one, the
  // extension dies at load with a syntax error on someone else's machine — fail here.
  const content = fs.readFileSync(path.join(OUT, "content.js"), "utf8");
  if (/^\s*(import|export)\s/m.test(content)) fail("content.js contains module syntax; it must be a classic script");

  // A hard-coded semver in the artifact is how `:version` printed `0.1.0+<commit>` on
  // every build up to 0.6.0. The prefix must come from package.json; if a literal
  // `"<semver>+"` survives into the bundle it has to name THIS version. (Absent is
  // fine: the bundler may fold the prefix into the stamp instead.)
  for (const [literal] of content.matchAll(/"(\d+\.\d+\.\d+)\+"/g)) {
    const semver = literal.slice(1, -2);
    if (semver !== pkg.version) fail(`content.js hard-codes semver "${semver}+" — this build is ${pkg.version}`);
  }

  const files = walk(OUT).map((f) => path.relative(OUT, f)).sort();
  console.log(`built ${path.relative(ROOT, OUT)}/ — ${files.length} files, ${(sizeOf(OUT) / 1024).toFixed(0)} KiB`);
  console.log(`  version ${versionName}`);

  if (!noZip) {
    const zip = path.join(OUT, `jsbarevi-${pkg.version}.zip`);
    execFileSync("zip", ["-q", "-r", "-X", zip, ...files], { cwd: OUT });
    console.log(`  ${path.relative(ROOT, zip)} — ${(fs.statSync(zip).size / 1024).toFixed(0)} KiB (upload this)`);
  }

  // Put back what this build does not own — AFTER the zip, never before: restoring first
  // made the previous zip and the Lark payload part of `files`, so the artifact shipped
  // with a copy of both inside it (67 KiB became 123 KiB, and the store package contained
  // a 239 KB dev payload). A freshly built zip of the same name wins over the old one.
  for (const [name, bytes] of carried) {
    const target = path.join(OUT, name);
    if (fs.existsSync(target)) continue;
    fs.writeFileSync(target, bytes);
  }
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

function sizeOf(dir) {
  return walk(dir).reduce((n, f) => n + fs.statSync(f).size, 0);
}

main().catch((err) => fail(err.stack || String(err)));
