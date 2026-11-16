#!/usr/bin/env node
// The Cursor seam payload.
//
// Cursor is a VS Code fork, so the workbench is plain files — but the extension system is
// not a route: what we may write is one sibling script plus one `<script>` tag in
// `workbench.html`, and then the page belongs to us. The chat/agent composer is a
// TipTap/ProseMirror contenteditable, which is the adapter jsbarevi already has for
// OpenCode's composer; the EDITOR is Monaco and is refused by the gate on purpose (a
// hidden `.inputarea` textarea that a textarea-aware vim layer would happily grab, while
// Cursor ships its own editor vim mode).
//
// This tool produces the payload the sibling installer injects
// (`_local/bin/cursor-ext-patch`), and it produces it from the SAME packager the
// extension ships through, so the two cannot drift. Three host differences, all of them
// facts about Cursor's CSP rather than preferences:
//
//   * beacons use `fetch`, not `Image` — `connect-src … http:` is allowed,
//     `img-src` is not;
//   * there is no `chrome.*` in the workbench page world, so settings come from
//     `localStorage["jsbarevi:settings"]` (the path the Electron hosts proved) and the
//     live gate config comes from the beacon server;
//   * the page's own `blur()` prototype is patched here, because this file IS the page
//     world — the extension ships that patch as a separate MAIN-world file.
//
// The first line is a contract with the installer, not decoration: it recognises the
// payload as ours by that banner and by the `__cursorVimInjected` marker — the same
// marker an Input Vim payload uses, so the two engines can never both be installed.
//
//   node tools/cursor-payload.mjs                 # build dist/cursor-payload.js
//   node tools/cursor-payload.mjs --print-install
//
// Then, in the monorepo:  _local/bin/cursor-ext-patch patch   (sudo) and restart Cursor.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bundleContentScripts } from "./bundle-content.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "dist", "cursor-payload.js");
// The same file `_local/bin/cursor-ext-patch` reads: one config, two readers.
const CONFIG = path.join(ROOT, "..", "..", "_local", "scratchpad", "ext-injection", "config", "cursor.json");
const BEACON = "http://127.0.0.1:8765";
const DEFAULT_CONFIG = { enabled: true, gateSelector: "[class*=composer]", logFocus: true, startMode: "insert" };

const args = process.argv.slice(2);
const printInstall = args.includes("--print-install");

function config() {
  const cfg = { ...DEFAULT_CONFIG };
  for (const candidate of [process.env.CURSOR_GATE_CONFIG, CONFIG]) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    try {
      Object.assign(cfg, JSON.parse(fs.readFileSync(candidate, "utf8")));
      break;
    } catch (err) {
      console.error(`cursor-payload: ${candidate} unreadable (${err.message}); using defaults`);
    }
  }
  return cfg;
}

/**
 * The activation gate.
 *
 * Cursor's composer is the target; everything else keeps its own keys. The two refusals
 * are the recorded hazard, not taste:
 *
 *   * anything inside `.monaco-editor` — the code editor's input is a hidden
 *     `<textarea class="inputarea">`, and taking it fights Monaco's model, Cursor's key
 *     handling and Cursor's own editor vim mode all at once;
 *   * `class="inputarea"` — the same node seen from the inside.
 *
 * `[class*=composer]` is the selector the Input Vim study measured on real Cursor builds
 * (`composer-input`, `has-composer-editor`) and it stays configurable from the beacon so
 * a layout change is a file edit, not a re-patch and a sudo.
 */
function gate(cfg) {
  return `
  // --- activation gate (jsbarevi) ------------------------------------------
  var reported = 0;
  globalThis.jsbareviHostGate = function (el) {
    var CFG = globalThis.__cursorVimCfg || ${JSON.stringify(DEFAULT_CONFIG)};
    if (CFG.enabled === false) return false;
    try {
      if (el.closest && el.closest(".monaco-editor")) return false;
      if (el.classList && el.classList.contains("inputarea")) return false;
    } catch (e) { return false; }
    var selector = CFG.gateSelector || "[class*=composer]";
    var host = null;
    try { host = el.closest ? el.closest(selector) : null } catch (e) { host = null }
    if (CFG.logFocus) {
      // Throttled: eligibility is asked on every keydown that lands in an editable we do
      // not own, and an unthrottled beacon would be one request per keystroke.
      var now = Date.now();
      if (now - reported > 1000) {
        reported = now;
        report("cursor-focus",
          el.tagName + "." + String(el.className || "").slice(0, 60) +
          " | gate=" + selector + " | inComposer=" + !!host +
          " | host=" + (host ? String(host.className || "").slice(0, 80) : "-"));
      }
    }
    return !!host;
  };
  report("cursor-gated", ${JSON.stringify(cfg.gateSelector)});
`;
}

function main() {
  const cfg = config();
  const { content, blocker } = bundleContentScripts();
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const build = JSON.parse(fs.readFileSync(path.join(ROOT, "dist", "build.json"), "utf8"));
  const stamp = `${pkg.version}+${build.stamp ?? build.build ?? "unknown"}`;

  const payload = `/* cursor-ext-patch — injected — engine jsbarevi ${stamp} · see _repos/jsbarevi/tools/cursor-payload.mjs */
;(function () {
  // The installer's marker, and the reason two engines can never both be live: an Input
  // Vim payload sets the same flag.
  if (globalThis.__cursorVimInjected) return;
  globalThis.__cursorVimInjected = true;

  var BEACON = ${JSON.stringify(BEACON)};
  // fetch, not Image: the workbench CSP allows connect-src http: but not img-src http:.
  var report = function (src, detail) {
    try {
      var url = BEACON + "/beacon?src=" + src + "&u=" + encodeURIComponent(location.href.slice(0, 140)) +
        (detail ? "&d=" + encodeURIComponent(String(detail).slice(0, 300)) : "");
      fetch(url, { mode: "no-cors", cache: "no-store" }).catch(function () {});
    } catch (e) {}
    // Disk-side breadcrumb: works with the beacon server down.
    try { localStorage.setItem("cursorExtProof", src + " " + Date.now()); } catch (e) {}
  };
  report("cursor-page", document.title || "");
  report("cursor-engine", ${JSON.stringify(stamp)});

  globalThis.__cursorVimCfg = ${JSON.stringify(cfg)};
  // Live config: retuning the gate needs no re-patch. Server down => the baked defaults.
  try {
    fetch(BEACON + "/cursor-config.json", { cache: "no-store" })
      .then(function (r) { return r.json() })
      .then(function (c) { Object.assign(globalThis.__cursorVimCfg, c || {}) })
      .catch(function () {});
  } catch (e) {}

  // Settings without chrome.*: the content script falls back to this key, which is also
  // what the extension's own popup path writes elsewhere. Seeded once, never overwritten,
  // so a choice made here survives the next launch.
  try {
    var store = {};
    try { store = JSON.parse(localStorage.getItem("jsbarevi:settings") || "{}") || {}; } catch (e) {}
    if (store.startMode === undefined && ${JSON.stringify(cfg.startMode ?? "insert")}) store.startMode = ${JSON.stringify(cfg.startMode ?? "insert")};
    if (store.enabled === undefined) store.enabled = true;
    localStorage.setItem("jsbarevi:settings", JSON.stringify(store));
  } catch (e) {}

  // The edit-failure sink the contenteditable adapter reports through (a no-op elsewhere).
  globalThis.__jsbareviReport = report;
${gate(cfg)}
  // --- blur() patch (the extension's MAIN-world file; here we ARE the page world) -----
  // Honest limitation: Cursor has already started, so a handler that captured
  // HTMLElement.prototype.blur before this line still holds the native method. Everything
  // the app calls afterwards is covered, and the content script's focus guard covers the
  // rest.
${blocker}
  // --- jsbarevi content script (bundled; one classic script) -----------------
${content}
})();
`;

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, payload);

  // Syntax-check the ARTEFACT: the wrapper and the bundle are two halves that can each
  // break, and this file is written into an application whose startup we then trust.
  execFileSync(process.execPath, ["--check", OUT], { stdio: "inherit" });
  console.log(`cursor payload: ${path.relative(ROOT, OUT)} (${(payload.length / 1024).toFixed(0)} KiB)`);
  console.log(`  engine: jsbarevi ${stamp} · gate: ${cfg.gateSelector} · beacon: ${BEACON} · config: ${fs.existsSync(CONFIG) ? CONFIG : "defaults"}`);
  if (printInstall) {
    console.log("\n  _local/bin/cursor-ext-patch patch   (needs sudo; restart Cursor afterwards)");
  }
}

try {
  main();
} catch (err) {
  console.error(`cursor-payload: ${err.message}`);
  process.exit(1);
}
