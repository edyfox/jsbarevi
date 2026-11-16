// End-to-end test for the WEBVIEW PAYLOAD — the artifact the plugin chat webviews get.
//
// Claude Code and Codex render their chat as a VS Code extension webview: a separate
// sandboxed document with its own bundle. The installer appends this payload to that
// bundle, so what has to be true is narrower than for Cursor (there is no editor surface
// in these documents) and different in one important way:
//
//   * the composer is `contenteditable="plaintext-only"` (Claude) or a ProseMirror root
//     (Codex) — both must be claimed by the gate, and plaintext-only is a shape no other
//     host in this repo uses;
//   * nothing else in the document must be claimed, and a Monaco-shaped `.inputarea`
//     must stay native even here.
//
//   node test/webview-payload.mjs

import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome, openPage, evaluate, waitFor, typeKeys, sleep } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAYLOAD = path.join(ROOT, "dist", "webview-payload.js");

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

// A webview is a whole document, so the fixture IS the interesting part: Claude's
// plaintext-only message box, a Codex-shaped ProseMirror editor, and two things that must
// stay native (a Monaco-like textarea and a bare editable).
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Claude Code</title>
<style>
  body{font:16px system-ui;margin:0;padding:20px;background:#1f1f1f;color:#e6e8eb}
  [contenteditable],textarea{width:520px;min-height:60px;padding:10px;margin:10px 0;
    border:1px solid #333;border-radius:6px;background:#171717;outline:none;white-space:pre-wrap}
</style></head>
<body>
<!-- Claude Code's message box: the composer the gate is anchored on. -->
<div id="claudeInput" contenteditable="plaintext-only" role="textbox" aria-label="Message input">hello claude</div>
<!-- Codex's composer: a ProseMirror root inside the chat webview. -->
<div class="ProseMirror" id="codexInput" contenteditable="true" role="textbox">hello codex</div>
<!-- must stay native: an editor surface and a bare editable with no composer anchor. -->
<textarea class="inputarea" id="notUs">const x = 1;</textarea>
<div id="stray" contenteditable="true">not a composer</div>
<script src="/webview-payload.js"></script>
</body></html>`;

function build() {
  // Rebuilt every run: this payload inlines the engine, and a stale one is refused by the
  // installer for exactly that reason.
  execFileSync(process.execPath, [path.join(ROOT, "tools", "webview-payload.mjs")], { cwd: ROOT, stdio: "inherit" });
}

function serve() {
  const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/webview-payload.js") {
      const body = fs.readFileSync(PAYLOAD);
      res.writeHead(200, { "content-type": "text/javascript", "content-length": body.length });
      res.end(body);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const consumed = (page, selector) => evaluate(page, `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  el.focus();
  const e = new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e.defaultPrevented;
})()`);

async function main() {
  build();
  const server = await serve();
  const port = server.address().port;
  const chromePort = 9650 + Math.floor(Math.random() * 100);
  const { child } = await launchChrome({ port: chromePort });
  let page;
  try {
    page = await openPage(chromePort, `http://127.0.0.1:${port}/`);
    await waitFor(page, "!!globalThis.__chatWebviewVimInjected", 10000);
    await sleep(150);

    console.log("\n\x1b[1mthe payload installs itself like a webview bundle would\x1b[0m");
    check("the payload ran", await evaluate(page, "!!globalThis.__chatWebviewVimInjected"), true);
    check("it defines the host gate", await evaluate(page, "typeof globalThis.jsbareviHostGate"), "function");
    check("it left a breadcrumb", await evaluate(page, "(localStorage.getItem('webviewExtProof') || '').includes('webview-')"), true);
    check("the edit-failure sink is wired", await evaluate(page, "typeof globalThis.__jsbareviReport"), "function");

    console.log("\n\x1b[1mthe gate: composers yes, the rest no\x1b[0m");
    check("a Monaco-shaped .inputarea stays native", await consumed(page, "#notUs"), false);
    check("a bare contenteditable stays native", await consumed(page, "#stray"), false);
    check("no engine attached yet", await evaluate(page, "document.querySelectorAll('.jsbarevi-badge').length"), 0);

    for (const [label, selector] of [
      ["Claude's plaintext-only Message input", "#claudeInput"],
      ["Codex's ProseMirror composer", "#codexInput"],
    ]) {
      await evaluate(page, `document.querySelector(${JSON.stringify(selector)}).focus()`);
      await sleep(250);
      const st = await evaluate(page, `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        return { marker: el.getAttribute('data-jsbarevi-mode'), badges: document.querySelectorAll('.jsbarevi-badge').length };
      })()`);
      check(`${label} is ours, starting in INSERT`, st.marker, "INSERT");
      await typeKeys(page, "<Esc>");
      check(`...Escape reaches NORMAL (${label})`,
        await evaluate(page, `document.querySelector(${JSON.stringify(selector)}).getAttribute('data-jsbarevi-mode')`), "NORMAL");
      const before = await evaluate(page, `document.querySelector(${JSON.stringify(selector)}).innerText`);
      await typeKeys(page, "dw");
      const after = await evaluate(page, `document.querySelector(${JSON.stringify(selector)}).innerText`);
      check(`...dw edits the host's DOM (${label})`, after !== before, true);
      await typeKeys(page, "u");
      check(`...u restores it (${label})`,
        await evaluate(page, `document.querySelector(${JSON.stringify(selector)}).innerText`), before);
      await typeKeys(page, "i<Esc>");
    }

    // Typing in INSERT must reach the host untouched — that is the whole point of a
    // composer we do not break.
    await evaluate(page, "document.getElementById('claudeInput').focus()");
    await sleep(200);
    // The loop above left the field in NORMAL, so enter insert first: `abc` typed in
    // NORMAL is three commands (`a` would itself enter insert).
    await typeKeys(page, "iabc");
    check("insert-mode typing still lands in the composer",
      (await evaluate(page, "document.getElementById('claudeInput').innerText")).includes("abc"), true);

    console.log(`\n${fail === 0 ? "\x1b[32m" : "\x1b[31m"}${pass} passed, ${fail} failed\x1b[0m`);
    process.exit(fail === 0 ? 0 : 1);
  } finally {
    try { page?.close(); } catch { /* ignore */ }
    child.kill("SIGKILL");
    server.close();
  }
}

main().catch((err) => { console.error("webview-payload test crashed:", err); process.exit(2); });
