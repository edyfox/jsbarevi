#!/usr/bin/env node
// The Lark seam payload.
//
// Lark on Linux is not Electron: the extension system and devtools are compiled out of
// `liblark.so`, and the UI is served from a custom scheme (`native-resource://`), so no
// content-script match pattern can ever apply. The only seam is the asar entry every
// shell loads — `resource.asar → js/after-js-load.js` — which
// `_local/bin/lark-ext-patch` appends to and rebuilds with its asar integrity
// recomputed. See `_local/scratchpad/ext-injection/lark.md`.
//
// This tool produces THAT payload for jsbarevi: the packaged content script (bundled by
// the same tool that packs the Chrome extension, so the two cannot drift) plus the three
// things the extension supplied through its own machinery:
//
//   * a host gate — the script loads in all ~340 Lark shells and the Docs/Bitable
//     editors are contenteditable too, so only the chat composer is ours. The content
//     script asks `globalThis.jsbareviHostGate`;
//   * the `blur()` patch the extension ships as a MAIN-world file. Here we ARE the page
//     world, so it needs no separate content script;
//   * a beacon — there is no devtools and no extension console to read a diagnostic
//     from, so the gate is tuned against what Lark actually focuses. Same beacon and
//     same config file as the Input Vim payload had, so retuning still needs no
//     re-patch and no sudo.
//
// Settings need no `chrome.storage` shim: with no `chrome.*` at all the content script
// already falls back to its own defaults plus `localStorage["jsbarevi:settings"]` — the
// path Electron hosts proved. `:e` will usually be refused by Lark's CSP (a page on a
// custom scheme may not fetch `http://127.0.0.1`); the engine is the point, and the
// status line says so rather than failing silently.
//
//   node tools/lark-payload.mjs                       # build dist/lark-payload.js
//   node tools/lark-payload.mjs --print-install       # …and print the install command

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bundleContentScripts } from "./bundle-content.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "dist", "lark-payload.js");
const CONFIG = path.join(ROOT, "..", "..", "_local", "scratchpad", "ext-injection", "config", "lark.json");
const BEACON = "http://127.0.0.1:8765";
const DEFAULT_CONFIG = { enabled: true, gateSelector: "[class*=chat]", logFocus: true };

const args = process.argv.slice(2);
const printInstall = args.includes("--print-install");

function config() {
  const cfg = { ...DEFAULT_CONFIG };
  for (const candidate of [process.env.LARK_GATE_CONFIG, CONFIG]) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    try {
      Object.assign(cfg, JSON.parse(fs.readFileSync(candidate, "utf8")));
      break;
    } catch (err) {
      console.error(`lark-payload: ${candidate} unreadable (${err.message}); using defaults`);
    }
  }
  return cfg;
}

/**
 * The gate.
 *
 * Lark chat is the target; Docs, Bitable, calendar and mail are contenteditable too and
 * must keep their own keys. `[class*=chat]` is the selector the Input Vim payload was
 * tuned to against real focused elements, and it stays configurable from the beacon so
 * retuning is a file edit rather than a re-patch.
 *
 * The report is throttled: eligibility is asked on every keydown that lands in an
 * editable we do not own, so an unthrottled beacon would emit one request per keystroke
 * for the whole time someone types in a Lark doc.
 */
function gate(cfg) {
  return `
  // --- activation gate (jsbarevi) -------------------------------------------
  var reported = 0;
  globalThis.jsbareviHostGate = function (el) {
    var CFG = globalThis.__larkVimCfg || ${JSON.stringify(DEFAULT_CONFIG)};
    if (CFG.enabled === false) return false;
    var selector = CFG.gateSelector || "[class*=chat]";
    var host = null;
    try { host = el.closest ? el.closest(selector) : null } catch (e) { host = null }
    if (CFG.logFocus) {
      var now = Date.now();
      if (now - reported > 1000) {
        reported = now;
        report("lark-focus",
          el.tagName + "." + String(el.className || "").slice(0, 60) +
          " | gate=" + selector + " | inChat=" + !!host +
          " | host=" + (host ? String(host.className || "").slice(0, 80) : "-"));
      }
    }
    return !!host;
  };
  report("lark-gated", ${JSON.stringify(cfg.gateSelector)});
`;
}

function main() {
  const cfg = config();
  const { content, blocker } = bundleContentScripts();

  const payload = `;(function () {
  if (globalThis.__larkVimInjected) return;
  globalThis.__larkVimInjected = true;

  var BEACON = ${JSON.stringify(BEACON)};
  var report = function (src, detail) {
    var text = "[lark-ext] " + src + " " + String(detail || "") + " " + location.href.slice(0, 100);
    // disk channel: Lark's own frontend log survives CSP / mixed-content blocks
    try {
      if (globalThis.ShellAPI && ShellAPI.app && ShellAPI.app.log) {
        ShellAPI.app.log({ logModule: "lark-ext", level: 3, message: text });
      }
    } catch (e) {}
    // network channel: beacons + runtime gate config
    try {
      var img = new Image();
      img.src = BEACON + "/beacon?src=" + src + "&u=" + encodeURIComponent(location.href.slice(0, 140)) +
        (detail ? "&d=" + encodeURIComponent(String(detail).slice(0, 900)) : "");
    } catch (e) {}
  };
  report("lark-page", document.title || "");
  // Diagnostics for the ENGINE: when an edit goes wrong in this host we cannot step
  // through, the adapter reports through this sink and it lands in Lark's own log and on
  // the beacon server. Absent anywhere else, so the adapter's call is a no-op there.
  globalThis.__jsbareviReport = report;

  // --- the HOST side of an edit (jsbarevi) --------------------------------------
  //
  // Lark's editor-kit keeps its own document model, and this app refuses DevTools
  // ("DevTools remote debugging is disallowed by the system admin"), so an edit that
  // wedges the composer cannot be watched from outside. Watch it from inside instead:
  // every execCommand the engine issues, every beforeinput the host sees (and whether it
  // cancels it), every input it dispatches, and any exception. Config-gated — one beacon
  // per edit is cheap, but it is not something to leave on.
  var traced = function () {
    var c = globalThis.__larkVimCfg;
    return !!(c && c.trace);
  };
  var fieldNow = function () {
    try {
      var el = document.activeElement || document.querySelector(".innerdocbody");
      var sel = getSelection();
      return {
        text: String((el && (el.innerText || el.textContent)) || "").slice(0, 160),
        kids: el ? el.childNodes.length : -1,
        html: el ? String(el.innerHTML || "").slice(0, 200) : "",
        sel: sel ? (sel.isCollapsed ? "caret@" + sel.anchorOffset : "range " + String(sel).slice(0, 40)) : "-"
      };
    } catch (e) { return { error: String(e) } }
  };
  var nativeExec = document.execCommand;
  document.execCommand = function (cmd) {
    if (!traced()) return nativeExec.apply(document, arguments);
    var before = fieldNow();
    var ok, threw = null;
    try { ok = nativeExec.apply(document, arguments) } catch (e) { threw = String(e); }
    var after = fieldNow();
    // Short fields FIRST, html last: report() truncates, and a truncated record whose
    // first fields are still readable is worth more than one that ends mid-html.
    report("lark-exec", JSON.stringify({
      cmd: cmd, arg: arguments[1], ok: ok === undefined ? null : ok, threw: threw,
      changed: before.text !== after.text,
      from: before.text, to: after.text, sel: before.sel + ">" + after.sel,
      kids: before.kids + ">" + after.kids, html: after.html
    }));
    if (threw) throw threw;
    return ok;
  };
  document.addEventListener("beforeinput", function (e) {
    if (!traced()) return;
    var it = e.inputType, cancelable = e.cancelable;
    setTimeout(function () {
      report("lark-beforeinput", JSON.stringify({ it: it, data: e.data === null ? null : String(e.data || "").slice(0, 40), cancelable: cancelable, cancelled: e.defaultPrevented }));
    }, 0);
  }, true);
  document.addEventListener("input", function (e) {
    if (!traced()) return;
    report("lark-input", JSON.stringify({ it: e.inputType, data: e.data === null ? null : String(e.data || "").slice(0, 40), after: fieldNow().text }));
  }, true);
  window.addEventListener("error", function (e) {
    report("lark-error", String(e.message || "") + " @ " + String(e.filename || "").slice(-40) + ":" + (e.lineno || 0) + " " + String(e.error && e.error.stack || "").slice(0, 200));
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    report("lark-error", "rejection " + String(r && (r.stack || r.message || r)).slice(0, 250));
  });
  document.addEventListener("focusout", function (e) {
    if (!traced()) return;
    report("lark-focusout", String(e.target && e.target.className || e.target && e.target.tagName || "?").slice(0, 90));
  }, true);

  // Runtime config lives on the beacon server: changing the gate needs no re-patch.
  globalThis.__larkVimCfg = ${JSON.stringify(cfg)};
  try {
    fetch(BEACON + "/lark-config.json", { cache: "no-store" })
      .then(function (r) { return r.json() })
      .then(function (c) { Object.assign(globalThis.__larkVimCfg, c || {}) })
      .catch(function () {});
  } catch (e) {}
${gate(cfg)}
  // --- blurer patch (the extension's MAIN-world file; here we ARE the page world) --
  // Honest limitation: Lark has already started, so a handler that captured
  // HTMLElement.prototype.blur before this line still has the native method. Everything
  // the app calls later is covered, and the focus-reclaim guard covers the rest.
${blocker}
  // --- jsbarevi content script (bundled; one classic script) -----------------
${content}
})();
`;

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, payload);

  // Syntax-check the artefact, not the source: the bundle and the wrapper are two
  // halves that can each break, and this file is appended to a container whose
  // integrity is then trusted by a running application.
  execFileSync(process.execPath, ["--check", OUT], { stdio: "inherit" });
  console.log(`lark payload: ${path.relative(ROOT, OUT)} (${(payload.length / 1024).toFixed(0)} KiB)`);
  console.log(`  gate: ${cfg.gateSelector} · beacon: ${BEACON} · config: ${fs.existsSync(CONFIG) ? CONFIG : "defaults"}`);
  if (printInstall) {
    console.log(`\n  LARK_PAYLOAD_FROM=${OUT} ../../_local/bin/lark-ext-patch patch`);
  }
}

try {
  main();
} catch (err) {
  console.error(`lark-payload: ${err.message}`);
  process.exit(1);
}
