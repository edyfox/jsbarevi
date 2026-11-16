#!/usr/bin/env node
// The page-world payload for PLUGIN-SHIPPED chat webviews (Claude Code, Codex).
//
// These are VS Code extension webviews: a sandboxed document the extension renders
// inside the editor, with its own CSP and its own bundle. There is no extension system to
// hook and no HTML we may edit — the one supported seam is the loaded webview bundle,
// which the sibling installer appends to (`_local/bin/chat-webview-ext-patch`).
//
// So this payload is deliberately the same engine and the same shape as the Cursor one
// (one packager, one adapter, one editing model), with three host facts changed:
//
//   * the GATE — a chat webview is a document whose whole purpose is a composer, so the
//     list is wider than Cursor's: Claude's `aria-label="Message input"`, Codex's
//     ProseMirror root, and the prompt-input kit if a build reuses it;
//   * the MARKER is its own (`__chatWebviewVimInjected`), because these documents are
//     separate from the workbench and must not stand each other down;
//   * telemetry is best-effort: a webview's CSP usually leaves `connect-src` out, so the
//     beacon may be blocked. It stays behind try/catch, `console.info` carries the same
//     lines to the webview devtools, and the localStorage breadcrumb is the disk-side
//     proof that the payload ran at all.
//
//   node tools/webview-payload.mjs                  # build dist/webview-payload.js
//   node tools/webview-payload.mjs --print-install
//
// Then:  _local/bin/chat-webview-ext-patch patch --extension claude   (no sudo; your home)
//        restart the editor, open the Claude Code panel, `Esc i` in the message box.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bundleContentScripts } from "./bundle-content.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "dist", "webview-payload.js");
const CONFIG = path.join(ROOT, "..", "..", "_local", "scratchpad", "ext-injection", "config", "webview.json");
const BEACON = "http://127.0.0.1:8765";
const GATE = '[aria-label="Message input"], .ProseMirror, [class*=composer], .agent-prompt-input-root';
const DEFAULT_CONFIG = { enabled: true, gateSelector: GATE, logFocus: true, startMode: "insert" };
// The installer refuses a payload body that contains its own marker string, so this
// banner names the engine and the repo, never the installer.
const BANNER = "page-world payload";

const args = process.argv.slice(2);
const printInstall = args.includes("--print-install");

function config() {
  const cfg = { ...DEFAULT_CONFIG };
  for (const candidate of [process.env.WEBVIEW_GATE_CONFIG, CONFIG]) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    try {
      Object.assign(cfg, JSON.parse(fs.readFileSync(candidate, "utf8")));
      break;
    } catch (err) {
      console.error(`webview-payload: ${candidate} unreadable (${err.message}); using defaults`);
    }
  }
  return cfg;
}

/**
 * The activation gate for a plugin chat webview.
 *
 * Wider than Cursor's on purpose: the whole document is the assistant's conversation, so
 * anything that is a real composer in here is ours. Still refuses the two shapes that
 * must stay native everywhere: Monaco's hidden `.inputarea` (an editor surface) and our
 * own command line.
 */
function gate(cfg) {
  return `
  // --- activation gate (jsbarevi) ------------------------------------------
  var reported = 0;
  globalThis.jsbareviHostGate = function (el) {
    var CFG = globalThis.__chatWebviewVimCfg || ${JSON.stringify(DEFAULT_CONFIG)};
    if (CFG.enabled === false) return false;
    try {
      if (el.closest && el.closest(".monaco-editor")) return false;
      if (el.classList && el.classList.contains("inputarea")) return false;
      if (el.hasAttribute && el.hasAttribute("data-jsbarevi-ui")) return false;
    } catch (e) { return false; }
    var selector = CFG.gateSelector || ${JSON.stringify(GATE)};
    var host = null;
    try { host = el.closest ? el.closest(selector) : null } catch (e) { host = null }
    if (CFG.logFocus) {
      var now = Date.now();
      if (now - reported > 1000) {
        reported = now;
        report("webview-focus",
          el.tagName + "." + String(el.className || "").slice(0, 60) +
          " | gate=" + selector + " | inComposer=" + !!host);
      }
    }
    return !!host;
  };
  report("webview-gated", ${JSON.stringify(cfg.gateSelector)});
`;
}

function main() {
  const cfg = config();
  const { content, blocker, build } = bundleContentScripts();
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const stamp = `${pkg.version}+${build.stamp ?? build.build ?? "unknown"}`;

  const payload = `/* ${BANNER} — engine jsbarevi ${stamp} · see _repos/jsbarevi/tools/webview-payload.mjs */
;(function () {
  if (globalThis.__chatWebviewVimInjected) return;
  globalThis.__chatWebviewVimInjected = true;

  var BEACON = ${JSON.stringify(BEACON)};
  // Best-effort: a webview CSP often omits connect-src, so this may be blocked. The
  // console line and the localStorage breadcrumb always land.
  var report = function (src, detail) {
    var line = "[jsbarevi] " + src + (detail ? " " + detail : "");
    try { console.info(line); } catch (e) {}
    try { localStorage.setItem("webviewExtProof", line + " " + Date.now()); } catch (e) {}
    try {
      var url = BEACON + "/beacon?src=" + src + "&u=" + encodeURIComponent(location.href.slice(0, 140)) +
        (detail ? "&d=" + encodeURIComponent(String(detail).slice(0, 300)) : "");
      fetch(url, { mode: "no-cors", cache: "no-store" }).catch(function () {});
    } catch (e) {}
  };
  report("webview-page", document.title || location.protocol);
  report("webview-engine", ${JSON.stringify(stamp)});

  globalThis.__chatWebviewVimCfg = ${JSON.stringify(cfg)};
  try {
    fetch(BEACON + "/webview-config.json", { cache: "no-store" })
      .then(function (r) { return r.json() })
      .then(function (c) { Object.assign(globalThis.__chatWebviewVimCfg, c || {}) })
      .catch(function () {});
  } catch (e) {}

  // Settings without chrome.*: the same key the content script falls back to.
  try {
    var store = {};
    try { store = JSON.parse(localStorage.getItem("jsbarevi:settings") || "{}") || {}; } catch (e) {}
    if (store.startMode === undefined) store.startMode = ${JSON.stringify(cfg.startMode ?? "insert")};
    if (store.enabled === undefined) store.enabled = true;
    localStorage.setItem("jsbarevi:settings", JSON.stringify(store));
  } catch (e) {}

  globalThis.__jsbareviReport = report;
${gate(cfg)}
  // --- blur() patch (this file IS the page world) ---------------------------
${blocker}
  // --- jsbarevi content script (bundled; one classic script) ---------------
${content}
})();
`;

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, payload);
  execFileSync(process.execPath, ["--check", OUT], { stdio: "inherit" });

  console.log(`webview payload: ${path.relative(ROOT, OUT)} (${(payload.length / 1024).toFixed(0)} KiB)`);
  console.log(`  engine: jsbarevi ${stamp} · gate: ${cfg.gateSelector}`);
  console.log(`  config: ${fs.existsSync(CONFIG) ? CONFIG : "defaults (none on disk)"} · beacon: ${BEACON}`);
  if (printInstall) {
    console.log("\n  _local/bin/chat-webview-ext-patch patch --extension claude    # then restart the editor");
  }
}

try {
  main();
} catch (err) {
  console.error(`webview-payload: ${err.message}`);
  process.exit(1);
}
