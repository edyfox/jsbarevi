// End-to-end test for the CONTENTEDITABLE adapter, in real headless Chrome.
//
// The fixture is a chat composer shaped like the one that forced this adapter: a
// `role="textbox"` contenteditable holding one flat run of text, `<br>`s for
// newlines, and a non-editable mention chip. It also carries the two host behaviours
// that make a rich composer different from a textarea, and both are asserted:
//
//   * the host has its OWN keydown handler (Enter sends) — a key the engine consumes
//     must never reach it;
//   * the host keeps its own model and rebuilds it from the DOM on `input` — an
//     engine edit that did not dispatch `input` would leave the host sending stale
//     text while the screen showed the new text.
//
//   node test/contenteditable-e2e.mjs

import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome, openPage, evaluate, waitFor, typeKeys, sendKey, sleep } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json" };

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>composer fixture</title>
<style>
  body{margin:0;padding:24px;background:#14161a;color:#e6e8eb;font:15px/1.6 system-ui}
  #editor{width:520px;min-height:120px;padding:12px 14px;border-radius:10px;border:1px solid #2b3038;
    background:#0f1115;white-space:pre-wrap;outline:none}
  [data-mention]{color:#7fb4ff;background:#1b2a3d;border-radius:4px;padding:0 3px}
</style></head>
<body>
<div id="editor" role="textbox" aria-multiline="true" aria-label="Compose a message" contenteditable="true">hello world<br>second line <span contenteditable="false" data-mention="file" data-path="a.ts">@a.ts</span> tail</div>
<script type="module">
  window.hostLog = { keys: [], inputs: 0, model: "" };
  const editor = document.getElementById("editor");

  // A host keymap: Enter sends. This is the composer's own handler, and a key the
  // engine consumes must not reach it.
  editor.addEventListener("keydown", (e) => {
    window.hostLog.keys.push(e.key);
    if (e.key === "Enter") { e.preventDefault(); window.hostLog.sent = (window.hostLog.sent || 0) + 1; }
  });

  // A host model rebuilt from the DOM on every input, exactly like the real one.
  const parse = () => {
    let text = "";
    const visit = (n) => {
      if (n.nodeType === 3) { text += n.data; return; }
      if (n.nodeType !== 1) return;
      if (n.hasAttribute("data-mention")) { text += n.textContent; return; }
      if (n.tagName === "BR") { text += "\\n"; return; }
      [...n.childNodes].forEach(visit);
    };
    [...editor.childNodes].forEach((n, i, all) => {
      visit(n);
      if (n.nodeType === 1 && ["DIV", "P"].includes(n.tagName) && i < all.length - 1) text += "\\n";
    });
    return text;
  };
  editor.addEventListener("input", () => {
    window.hostLog.inputs++;
    window.hostLog.model = parse();
  });

  const { attach } = await import("/src/entry.js");
  window.handle = attach(editor, { editorUrl: "" });
  window.hostLog.model = parse();
  window.ready = true;
</script>
</body></html>`;

function serve() {
  const server = createServer((req, res) => {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    if (url === "/" || url === "/ce") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(PAGE);
      return;
    }
    const file = path.join(ROOT, url);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("nope");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "text/javascript" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function main() {
  const server = await serve();
  const port = server.address().port;
  const chromePort = 9550 + Math.floor(Math.random() * 100);
  const { child } = await launchChrome({ port: chromePort });
  let page;
  try {
    page = await openPage(chromePort, `http://127.0.0.1:${port}/ce`);
    await waitFor(page, "!!window.ready", 10000);

    const text = () => evaluate(page, "window.handle.engine.hostText");
    const cursor = () => evaluate(page, "window.handle.engine.cursor");
    const domText = () => evaluate(page, "document.getElementById('editor').innerText");
    const host = () => evaluate(page, "JSON.parse(JSON.stringify(window.hostLog))");
    const focus = () => evaluate(page, "document.getElementById('editor').focus()");

    await focus();
    await sleep(150);

    // The flat model is Input Vim's: text, "\n" for <br> and block joins, and a
    // mention chip contributing its own text (offsets inside it stay inside it).
    check("flat text matches the host's own model", await text(), "hello world\nsecond line @a.ts tail");
    check("caret starts on the first character", await cursor(), 0);

    // ---- motions ----------------------------------------------------------
    await typeKeys(page, "j");
    check("j moves to the second line", await cursor(), 12);
    await typeKeys(page, "w");
    check("w moves a word", await cursor(), 19);
    await typeKeys(page, "w");
    check("w lands on the mention", await cursor(), 24);
    await typeKeys(page, "w");
    // The buffer holds the mention's TEXT (Input Vim's model), so `w` steps into it
    // like text — "@" is punctuation, so the next word starts at "a". The ELEMENT is
    // still unbreakable, which the delete below proves.
    check("w steps into the mention's text", await cursor(), 25);

    // ---- operators over a rich document ----------------------------------
    await typeKeys(page, "0dd");
    check("dd removes the line from the buffer", await text(), "hello world");
    check("and from the DOM", (await domText()).trim(), "hello world");
    await typeKeys(page, "u");
    check("u restores the line", await text(), "hello world\nsecond line @a.ts tail");
    check("u restores the mention ELEMENT, not its text", await evaluate(page, "document.querySelectorAll('[data-mention]').length"), 1);

    // ---- deleting an unbreakable element ---------------------------------
    await typeKeys(page, "j0ww");
    check("cursor is on the mention", await cursor(), 24);
    await typeKeys(page, "x");
    check("x removes the whole element", await evaluate(page, "document.querySelectorAll('[data-mention]').length"), 0);
    check("and the buffer adopts what the host really did", await text(), "hello world\nsecond line  tail");
    await typeKeys(page, "u");
    check("undo brings the mention back", await evaluate(page, "document.querySelectorAll('[data-mention]').length"), 1);
    check("with its text", await text(), "hello world\nsecond line @a.ts tail");

    // ---- insert mode belongs to the host --------------------------------
    // gg0 = the real start of the document (0 alone is the start of the LINE, which
    // after the undo is line 2 — a reminder that the engine is vi, not a text input).
    await typeKeys(page, "gg0i");
    await typeKeys(page, "X");
    await typeKeys(page, "<Esc>");
    check("typed text landed at the cursor in the document", (await domText()).startsWith("Xhello"), true);
    check("and the host's own model saw it", (await host()).model.startsWith("Xhello"), true);

    // ---- a stale composition flag after Escape ---------------------------
    // Chrome can leave isComposing set on the first key after a composition is
    // cancelled by Escape. Dropping that key is invisible everywhere except to the
    // user, who sees "press it twice".
    await typeKeys(page, "gg");
    const composing = await evaluate(page, `(() => {
      const before = window.handle.engine.cursor;
      const ev = new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true, composed: true, isComposing: true });
      document.activeElement.dispatchEvent(ev);
      return { before, after: window.handle.engine.cursor };
    })()`);
    check("a key flagged isComposing in NORMAL is not dropped", composing.after !== composing.before, true);

    // ---- the host's keymap must not double-act ---------------------------
    const beforeKeys = (await host()).keys.length;
    await typeKeys(page, "<CR>");
    check("Enter in NORMAL does not reach the host keymap", (await host()).keys.length, beforeKeys);
    check("so nothing was sent", (await host()).sent ?? 0, 0);

    // ---- engine edits must tell the host ---------------------------------
    const beforeInputs = (await host()).inputs;
    await typeKeys(page, "dw");
    const afterCommit = await host();
    check("an engine edit dispatches input", afterCommit.inputs > beforeInputs, true);
    check("and the host re-parsed exactly the engine's buffer", afterCommit.model, await text());

    // ---- leaving insert at a line end ------------------------------------
    // The insertion point sits one past the last character; in NORMAL the native beam
    // must be gone, or what you see at the line end is a beam, not the block cursor.
    await typeKeys(page, "A");
    await typeKeys(page, "<Esc>");
    check("no native beam in NORMAL", await evaluate(page, "document.getElementById('editor').style.caretColor"), "transparent");
    check("the block cursor is drawn in NORMAL", await evaluate(page, "[...document.querySelectorAll('.jsbarevi-caret')].some((c) => getComputedStyle(c).display !== 'none')"), true);
    check("the cursor sits ON the last character, not past it", await evaluate(page, "window.handle.engine.hostText[window.handle.engine.cursor]"), await evaluate(page, "window.handle.engine.hostText.slice(-1)"));

    // ---- a blur that stands in for the Escape we never received ----------
    // Another extension can take the Escape keydown and blur the field. Leaving insert
    // must still take vim's step to the left, otherwise the block lands on the
    // character AFTER where the beam was — the reported "cursor covers the wrong char".
    await typeKeys(page, "gg0lll");
    await typeKeys(page, "iZ");
    const beforeBlur = await evaluate(page, "window.handle.engine.cursor");
    await evaluate(page, "document.activeElement.blur()");
    const afterBlur = await evaluate(page, "JSON.stringify({ mode: window.handle.engine.mode, cursor: window.handle.engine.cursor, under: window.handle.engine.hostText[window.handle.engine.cursor] })");
    check("a blur while inserting steps the cursor left", JSON.parse(afterBlur), { mode: "NORMAL", cursor: beforeBlur - 1, under: "Z" });
    await evaluate(page, "document.getElementById('editor').focus()");
    await sleep(120);

    // ---- visual line ------------------------------------------------------
    await typeKeys(page, "gg");
    const beforeVisual = await text();
    await typeKeys(page, "Vd");
    check("Vd deleted a line", (await text()) !== beforeVisual, true);
    await typeKeys(page, "u");
    check("u restored it", await text(), beforeVisual);

    // ---- :version reports the build --------------------------------------
    await typeKeys(page, ":version<CR>");
    check("status line carries the build", (await evaluate(page, "document.querySelector('.jsbarevi-line').textContent")).startsWith("jsbarevi 0.1.0+"), true);
    // ---------------------------------------------------------------------
    // `<C-r>{register}` in a rich composer.
    //
    // Insert mode belongs to the host, so the engine hands the adapter the text and
    // the adapter inserts it with execCommand at the host's own caret — the one way
    // that keeps the host's undo entry and cannot delete a chip the text ends inside.
    // ---------------------------------------------------------------------
    console.log("\n\x1b[1m<C-r>{register} in a rich composer\x1b[0m");
    // Earlier cases have edited this fixture, so start from a known document.
    await evaluate(page, `(() => {
      const el = document.getElementById('editor');
      el.textContent = "hello world";
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      return true;
    })()`);
    await sleep(60);
    await focus();
    await typeKeys(page, '"ayw');
    await typeKeys(page, "i");
    await sendKey(page, "C-r");
    await sendKey(page, "a");
    check("the register text landed in the DOM", (await domText()).startsWith("hello hello world"), true);
    check("...and the engine agrees", (await text()).startsWith("hello hello world"), true);
    await typeKeys(page, "<Esc>");
    check("...and NORMAL still works after Esc", await evaluate(page, "window.handle.engine.mode"), "NORMAL");

    // ---------------------------------------------------------------------
    // `ciw` in a rich composer: a CHANGE command, so it deletes and enters insert in
    // one keystroke combination — the shape that broke in Lark, while plain deletes
    // were fine. Here it is pinned, so a regression in either half is caught.
    // ---------------------------------------------------------------------
    console.log("\n\x1b[1mciw in a rich composer\x1b[0m");
    await evaluate(page, `(() => {
      const el = document.getElementById('editor');
      el.textContent = "hello world here";
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      return true;
    })()`);
    await sleep(60);
    await focus();
    await sleep(30);
    await typeKeys(page, "ciw");
    await sleep(60);
    check("ciw removes the word from the DOM", await domText(), " world here");
    check("...and the engine agrees", await text(), " world here");
    check("...and it is in INSERT, ready to type", await evaluate(page, "window.handle.engine.mode"), "INSERT");
    await typeKeys(page, "XYZ");
    await sleep(60);
    check("typed text lands where the word was", await domText(), "XYZ world here");
    check("...and the engine agrees", await text(), "XYZ world here");
    await typeKeys(page, "<Esc>");
    await sleep(40);
    check("...and Esc returns to NORMAL", await evaluate(page, "window.handle.engine.mode"), "NORMAL");

    // ---------------------------------------------------------------------
    // destroy() must leave the box as it found it.
    //
    // The beam is hidden INLINE in NORMAL/VISUAL, so a destroyed field that keeps
    // `caret-color: transparent` has an invisible caret: editing works and you cannot
    // see where you are. That is exactly what `:q` looked like in Lark's composer.
    // ---------------------------------------------------------------------
    console.log("\n\x1b[1mdestroy() leaves the box as it found it\x1b[0m");
    await focus();
    await typeKeys(page, "i");
    await typeKeys(page, "<Esc>");                 // NORMAL: the beam is hidden inline
    await sleep(40);
    check("the beam is hidden while the engine owns the field",
      await evaluate(page, "document.getElementById('editor').style.caretColor"), "transparent");
    await evaluate(page, "window.handle.destroy()");
    await sleep(40);
    check("...and visible again once it lets go",
      await evaluate(page, "document.getElementById('editor').style.caretColor"), "");
    check("...with no overlay left behind",
      await evaluate(page, "document.querySelectorAll('.jsbarevi-caret, .jsbarevi-sel, .jsbarevi-badge').length"), 0);
    check("...and no mode marker", await evaluate(page, "document.getElementById('editor').hasAttribute('data-jsbarevi-mode')"), false);

  } finally {
    try { page?.close(); } catch { /* ignore */ }
    child.kill("SIGKILL");
    server.close();
  }
  console.log(`\n  ${fail === 0 ? "\x1b[32m" : "\x1b[31m"}${pass} passed, ${fail} failed\x1b[0m`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
