// End-to-end test for the CURSOR PAYLOAD — the artefact, not the extension.
//
// The Cursor seam installs one script into the workbench page, and on that page there are
// two very different editables a few pixels apart. So the two things this test has to
// prove are exactly the seam's two failure modes:
//
//   * the GATE — a ProseMirror composer gets the engine; the code editor's hidden
//     `.inputarea` inside `.monaco-editor` is left completely alone (taking it fights
//     Monaco's model, Cursor's key handling AND Cursor's own editor vim mode), and so is
//     any editable outside a composer;
//   * the ENGINE inside that payload — mode changes, an edit that lands in the host's
//     DOM, and the `blur()` patch, all without `chrome.*`: a workbench page has neither
//     an extension origin nor a service worker.
//
// The fixture is shaped like the real one: `.monaco-editor > textarea.inputarea`, a
// `.composer-input.has-composer-editor` holding a `.ProseMirror` contenteditable, and a
// stray contenteditable that belongs to neither.
//
//   node test/cursor-host-payload.mjs

import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome, openPage, evaluate, waitFor, typeKeys, sleep } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAYLOAD = path.join(ROOT, "dist", "cursor-payload.js");

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>cursor-shaped fixture</title>
<style>
  body{margin:0;padding:24px;background:#1f1f1f;color:#e6e8eb;font:15px/1.6 system-ui}
  [contenteditable],textarea{width:460px;padding:10px 12px;margin:10px 0;
    border:1px solid #333;border-radius:6px;background:#171717;outline:none;white-space:pre-wrap}
  #monacoInput{height:60px;font:14px/1.6 monospace}
</style></head>
<body>
<!-- the code editor: hidden textarea inside .monaco-editor. NOT ours. -->
<div class="monaco-editor" id="editorSurface">
  <textarea class="inputarea" id="monacoInput">const answer = 42;</textarea>
</div>
<!-- the chat/agent composer: ProseMirror contenteditable inside a composer root. -->
<div class="composer-input has-composer-editor">
  <div id="composer" class="ProseMirror" contenteditable="true" role="textbox">hello composer</div>
</div>
<!-- an editable that is neither: a comment box somewhere in the workbench. NOT ours. -->
<div class="comment-widget"><div id="stray" contenteditable="true">a stray editable</div></div>
<!-- the AGENT panel's composer: same UI kit, but no "composer" in its class. -->
<div class="agent-prompt-input-root">
  <div id="agentComposer" class="ProseMirror" contenteditable="true" role="textbox">ask the agent</div>
</div>
<!-- the detached Agent window's composer shape (molten/dist/renderer: prompt-input kit). -->
<div class="ui-prompt-input__container">
  <div id="moltenComposer" class="ui-prompt-input-editor" contenteditable="true" role="textbox">detached agent</div>
</div>
<script src="/cursor-payload.js"></script>
</body></html>`;

function build() {
  // Built from the current source every run: a stale artefact is the failure this seam
  // already paid for once (the Input Vim payload reported a no-op that read as success).
  execFileSync(process.execPath, [path.join(ROOT, "tools", "cursor-payload.mjs")], { cwd: ROOT, stdio: "inherit" });
}

function serve() {
  const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/cursor-payload.js") {
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

/** Is a synthetic keydown in `selector` consumed by the engine? */
const consumed = (page, selector, key = "j") => evaluate(page, `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  el.focus();
  const e = new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e.defaultPrevented;
})()`);

async function main() {
  build();
  const server = await serve();
  const port = server.address().port;
  const chromePort = 9700 + Math.floor(Math.random() * 100);
  const { child } = await launchChrome({ port: chromePort });
  let page;
  try {
    page = await openPage(chromePort, `http://127.0.0.1:${port}/`);
    await waitFor(page, "!!globalThis.__cursorVimInjected", 10000);
    await sleep(150);

    console.log("\n\x1b[1mthe payload installs itself like the workbench would\x1b[0m");
    check("the payload ran", await evaluate(page, "!!globalThis.__cursorVimInjected"), true);
    check("it defines the host gate the content script asks for",
      await evaluate(page, "typeof globalThis.jsbareviHostGate"), "function");
    check("there is no chrome.storage to lean on (the workbench situation)",
      await evaluate(page, "typeof globalThis.chrome?.storage?.local?.get"), "undefined");
    check("it left a disk-side breadcrumb", await evaluate(page, "(localStorage.getItem('cursorExtProof') || '').startsWith('cursor-')"), true);
    check("it reports the gate it will use", await evaluate(page, "(globalThis.__cursorVimCfg || {}).gateSelector || ''"), "[class*=composer], .agent-prompt-input-root, [class*=prompt-input]");
    check("the edit-failure sink is wired", await evaluate(page, "typeof globalThis.__jsbareviReport"), "function");

    console.log("\n\x1b[1mthe gate: composer yes, Monaco no\x1b[0m");
    // The editor surface must stay invisible to us in every sense: no badge, no marker,
    // and its keys must reach Monaco unconsumed.
    check("Monaco's .inputarea is left alone", await consumed(page, "#monacoInput"), false);
    check("...no mode marker on it", await evaluate(page, "document.getElementById('monacoInput').hasAttribute('data-jsbarevi-active')"), false);
    check("a contenteditable outside a composer is left alone", await consumed(page, "#stray"), false);
    check("...and no engine was attached anywhere yet", await evaluate(page, "document.querySelectorAll('.jsbarevi-badge').length"), 0);

    // Focus first, then give the content script the tick it needs to attach (its
    // focusin path is a promise; the first key is claimed separately, which is why a
    // real keystroke is never lost).
    await evaluate(page, "document.getElementById('composer').focus()");
    await sleep(250);
    const composer = await evaluate(page, `(() => {
      const el = document.getElementById('composer');
      const e = new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true });
      el.dispatchEvent(e);
      return { consumed: e.defaultPrevented, mode: el.getAttribute('data-jsbarevi-mode') };
    })()`);
    check("the composer IS ours — the field is marked with its mode", composer.mode, "INSERT");
    check("...with exactly one badge", await evaluate(page, "document.querySelectorAll('.jsbarevi-badge').length"), 1);
    // A letter in INSERT is deliberately NOT consumed — the host types it. The engine's
    // ownership shows in NORMAL, where the same key is a motion.
    await typeKeys(page, "<Esc>");
    check("in NORMAL a letter is consumed as a command", await consumed(page, "#composer"), true);
    check("...and it moved the cursor instead of typing anything",
      await evaluate(page, "document.getElementById('composer').innerText"), "hello composer");
    await typeKeys(page, "i");

    console.log("\n\x1b[1mthe engine works with no chrome.* at all\x1b[0m");
    await typeKeys(page, "<Esc>");
    check("Escape reaches NORMAL", await evaluate(page, "document.getElementById('composer').getAttribute('data-jsbarevi-mode')"), "NORMAL");
    const before = await evaluate(page, "document.getElementById('composer').innerText");
    await typeKeys(page, "dw");
    const after = await evaluate(page, "document.getElementById('composer').innerText");
    check("a vi command edits the host's own DOM", {
      changed: after !== before, keptSecondWord: after.includes("composer"),
    }, { changed: true, keptSecondWord: true });
    await typeKeys(page, "u");
    check("u restores it", await evaluate(page, "document.getElementById('composer').innerText"), before);

    console.log("\n\x1b[1mthe Agent surfaces: same kit, other containers\x1b[0m");
    // The Agent panel inside the workbench window carries `agent-prompt-input-root` and
    // no "composer" class; the detached Agent window uses the `prompt-input` kit. Both are
    // the SAME component as the chat box, so both must be ours - and the editor still is
    // not, which the Monaco checks above already proved.
    for (const [label, selector] of [
      ["the Agent panel composer", "#agentComposer"],
      ["the detached Agent window's composer", "#moltenComposer"],
    ]) {
      await evaluate(page, `document.querySelector(${JSON.stringify(selector)}).focus()`);
      await sleep(250);
      const st = await evaluate(page, `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        return { marker: el.getAttribute('data-jsbarevi-mode'), badges: document.querySelectorAll('.jsbarevi-badge').length };
      })()`);
      check(`${label} is attached, starting in INSERT`, st.marker, "INSERT");
      await typeKeys(page, "<Esc>");
      const before = await evaluate(page, `document.querySelector(${JSON.stringify(selector)}).innerText`);
      await typeKeys(page, "dw");
      const after = await evaluate(page, `document.querySelector(${JSON.stringify(selector)}).innerText`);
      check(`...and a vi command edits its DOM (${label})`, after !== before, true);
      await typeKeys(page, "u");
      check(`...and u restores it (${label})`, await evaluate(page, `document.querySelector(${JSON.stringify(selector)}).innerText`), before);
      await typeKeys(page, "i<Esc>");
    }

    // A programmatic blur() is a function call, so no key handler can stop it: the
    // payload's page-world patch is the only thing that can.
    await evaluate(page, "document.getElementById('composer').focus()");
    await sleep(150);
    await evaluate(page, "document.getElementById('composer').blur()");
    check("a programmatic blur() cannot take the field away",
      await evaluate(page, "document.activeElement === document.getElementById('composer')"), true);

    console.log(`\n${fail === 0 ? "\x1b[32m" : "\x1b[31m"}${pass} passed, ${fail} failed\x1b[0m`);
    process.exit(fail === 0 ? 0 : 1);
  } finally {
    try { page?.close(); } catch { /* ignore */ }
    child.kill("SIGKILL");
    server.close();
  }
}

main().catch((err) => { console.error("cursor-payload test crashed:", err); process.exit(2); });
