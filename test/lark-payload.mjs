// End-to-end test for the LARK PAYLOAD — the artefact, not the extension.
//
// The Lark seam installs one script that loads in every Lark shell, so the two things
// that matter can only be checked on a page shaped like Lark's:
//
//   * the GATE — a contenteditable in a chat composer gets the engine; a
//     contenteditable in a document (Docs, Bitable, mail) must be left completely alone,
//     because Lark's editors would otherwise fight us for every key;
//   * the ENGINE inside that payload — mode changes, an edit that lands in the host's
//     DOM, and the blur() patch, all without `chrome.*`, an extension origin or a
//     service worker (a Lark page has none of them).
//
// The fixture is two editiables with the gate's real selector between them.
//
//   node test/lark-payload.mjs

import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome, openPage, evaluate, waitFor, typeKeys, sleep } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAYLOAD = path.join(ROOT, "dist", "lark-payload.js");

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

// A chat shell and a document editor in the same page — exactly Lark's situation, where
// one script is loaded by every module of a single-page app.
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>lark-shaped fixture</title>
<style>
  body{margin:0;padding:24px;background:#14161a;color:#e6e8eb;font:15px/1.6 system-ui}
  [contenteditable]{width:460px;min-height:80px;padding:10px 12px;margin:12px 0;
    border:1px solid #2b3038;border-radius:8px;background:#0f1115;outline:none;white-space:pre-wrap}
</style></head>
<body>
<div class="doc-editor"><div id="doc" contenteditable="true">document text</div></div>
<div class="lark-chat-composer"><div id="chat" contenteditable="true" role="textbox">hello world</div></div>
<div class="lark-chat-composer"><textarea id="chatInput">a textarea in a chat shell</textarea></div>
<script src="/lark-payload.js"></script>
<!-- The payload also fetches the LIVE gate config from the beacon server, and the deployed
     one now refuses edits that delete text (Lark's scope). This test is about the engine, so
     pin the switch open before any command runs. -->
<script>
  Object.defineProperty(globalThis, "__jsbareviDestructiveEdits", { get: () => true, configurable: true });
</script>
</body></html>`;

function build() {
  // The payload must be built from the CURRENT source; a stale artefact is the failure
  // this seam already paid for once (see `lark-ext-patch status`).
  //
  // The gate config is also baked in, and the DEPLOYED one now refuses edits that delete
  // text (Lark scopes them — see docs/DECISIONS.md). This test is about the engine, so it
  // builds with a config that allows everything.
  const cfg = path.join(os.tmpdir(), `lark-gate-test-${process.pid}.json`);
  fs.writeFileSync(cfg, JSON.stringify({
    enabled: true, gateSelector: "[class*=chat]", logFocus: false, trace: false,
    slowEdits: false, destructiveEdits: true,
  }));
  try {
    execFileSync(process.execPath, [path.join(ROOT, "tools", "lark-payload.mjs")], {
      cwd: ROOT, stdio: "inherit", env: { ...process.env, LARK_GATE_CONFIG: cfg },
    });
  } finally {
    try { fs.unlinkSync(cfg); } catch { /* ignore */ }
  }
}

function serve() {
  const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/lark-payload.js") {
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

async function main() {
  build();
  const server = await serve();
  const port = server.address().port;
  const chromePort = 9750 + Math.floor(Math.random() * 100);
  const { child } = await launchChrome({ port: chromePort });
  let page;
  try {
    page = await openPage(chromePort, `http://127.0.0.1:${port}/lark`);
    await waitFor(page, "!!globalThis.__larkVimInjected", 10000);
    await sleep(150);

    console.log("\n\x1b[1mthe payload installs itself like a Lark shell would\x1b[0m");
    check("the payload ran", await evaluate(page, "!!globalThis.__larkVimInjected"), true);
    check("it defines the host gate the content script asks for",
      await evaluate(page, "typeof globalThis.jsbareviHostGate"), "function");
    // A Chrome page always has a `chrome` object; what a Lark page lacks is the
    // EXTENSION surface, so the settings fallback is the thing to assert.
    check("there is no chrome.storage to lean on (the Lark situation)",
      await evaluate(page, "typeof (globalThis.chrome && globalThis.chrome.storage)"), "undefined");
    check("the content script is live and sees no fields yet",
      await evaluate(page, "globalThis.__jsbarevi.attachedCount()"), 0);

    console.log("\n\x1b[1mthe gate: chat yes, documents no\x1b[0m");
    await evaluate(page, "document.getElementById('doc').focus()");
    await sleep(120);
    check("a document editor is left alone — nothing attached",
      await evaluate(page, "document.getElementById('doc').hasAttribute('data-jsbarevi-active')"), false);
    check("...its text is untouched by us", await evaluate(page, "document.getElementById('doc').innerText"), "document text");
    check("...no badge either", await evaluate(page, "document.querySelectorAll('.jsbarevi-badge').length"), 0);
    // A key in a document must reach Lark un-consumed. The element's own listener is the
    // witness: a key the engine took would arrive with defaultPrevented set (or not at
    // all, since a consumed key stops propagation).
    await evaluate(page, `(() => {
      window.__docKeys = [];
      document.getElementById('doc').addEventListener('keydown', (e) => {
        window.__docKeys.push(e.key + ":" + e.defaultPrevented);
      });
      return true;
    })()`);
    await typeKeys(page, "x");
    check("a key in a document reaches Lark un-consumed", await evaluate(page, "window.__docKeys"), ["x:false"]);

    await evaluate(page, "document.getElementById('chat').focus()");
    await sleep(120);
    check("a chat composer IS ours",
      await evaluate(page, "document.getElementById('chat').hasAttribute('data-jsbarevi-active')"), true);
    check("...with the badge", await evaluate(page, "!!document.querySelector('.jsbarevi-badge')"), true);
    check("...starting in INSERT, like every browser field",
      await evaluate(page, "document.getElementById('chat').getAttribute('data-jsbarevi-mode')"), "INSERT");

    console.log("\n\x1b[1mthe engine works with no chrome.* at all\x1b[0m");
    await typeKeys(page, "<Esc>");
    check("Escape reaches NORMAL",
      await evaluate(page, "document.getElementById('chat').getAttribute('data-jsbarevi-mode')"), "NORMAL");
    await typeKeys(page, "x");
    check("a vi command edits the host's own DOM",
      await evaluate(page, "document.getElementById('chat').innerText"), "ello world");
    await typeKeys(page, "u");
    check("u restores it", await evaluate(page, "document.getElementById('chat').innerText"), "hello world");

    // The blur patch: the extension ships this as a MAIN-world file; in Lark the payload
    // already runs in the page's world, so the same protection applies.
    await evaluate(page, "window.__blurred = false; document.getElementById('chat').blur(); window.__blurred = document.activeElement.id !== 'chat'");
    check("a programmatic blur() cannot take the field away",
      await evaluate(page, "document.activeElement.id"), "chat");

    // A textarea inside a chat shell is ours too — the gate is the container, not the
    // element type, so one selector covers both kinds of composer.
    await evaluate(page, "document.getElementById('chatInput').focus()");
    await sleep(120);
    check("a textarea inside the chat shell attaches too",
      await evaluate(page, "document.getElementById('chatInput').hasAttribute('data-jsbarevi-active')"), true);

    // The gate reads the same beacon config as the Input Vim payload did, so retuning
    // (`gateSelector`, `enabled`) is a file edit followed by a Lark restart — no re-patch.
    check("the gate config is present in the page",
      await evaluate(page, "globalThis.__larkVimCfg && globalThis.__larkVimCfg.gateSelector"), "[class*=chat]");
  } finally {
    try { page?.close(); } catch {}
    child.kill("SIGKILL");
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error("lark payload test error:", err); process.exit(2); });
