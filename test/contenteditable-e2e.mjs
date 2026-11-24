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
// The semver the status line must print comes from package.json — never a literal here,
// which is how the test itself kept blessing the hard-coded `0.1.0` label.
const { version: VERSION } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
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
  window.attach = attach;
  window.handle = attach(editor, { editorUrl: "" });
  window.hostLog.model = parse();
  window.ready = true;
</script>
</body></html>`;

// ---- hosts with their own document MODEL (Lark's editor-kit) ------------------
//
// editor-kit does not rebuild its model from the DOM; it applies the edits it is told
// about and re-renders from its own string. Two shapes matter, and both broke the
// composer on 2026-11-24 (`C` on "test" ended up holding `cbtest`):
//
//   * it models `deleteContentBackward` literally — ONE character — so a ranged delete
//     we perform in the DOM removes one character in ITS copy;
//   * it renders that copy back over the field afterwards, with no `input` event.
const MODEL_HOST = `<!doctype html>
<meta charset="utf-8">
<style>#editor{width:520px;min-height:100px;padding:12px 14px;white-space:pre-wrap;outline:none}</style>
<div id="editor" contenteditable="true">test</div>
<script type="module">
  const editor = document.getElementById("editor");
  let model = "test";                       // the host's own copy, NOT read from the DOM
  window.hostLog = { model: () => model, rerenders: 0 };
  // The input event, NOT beforeinput: Chromium does not fire beforeinput for an edit
  // made through execCommand, which is how every jsbarevi edit reaches the DOM.
  editor.addEventListener("input", (e) => {
    const it = String(e.inputType || "");
    if (it === "deleteContentBackward") model = model.slice(0, -1);    // one character, literally
    else if (it === "deleteContentForward") model = model.slice(1);
    // A replace is one edit over a selection: the host removes exactly that span and puts
    // the data in its place. With no data it is a pure deletion; the DOM is the record of
    // which span was selected, which is what an editor applies here too.
    else if (it === "insertText") model = e.data ? model + e.data : editor.textContent;
  });
  window.rerender = () => { editor.textContent = model; window.hostLog.rerenders++; };
  const { attach } = await import("/src/entry.js");
  window.handle = attach(editor, { editorUrl: "" });
  window.ready = true;
</script>`;

// A host that simply does not believe the edit: it keeps its model and paints it back.
const REVERTING_HOST = `<!doctype html>
<meta charset="utf-8">
<style>#editor{width:520px;min-height:100px;padding:12px 14px;white-space:pre-wrap;outline:none}</style>
<div id="editor" contenteditable="true">test</div>
<script type="module">
  const editor = document.getElementById("editor");
  const model = "test";
  window.hostLog = { reverts: 0 };
  window.reports = [];
  globalThis.__jsbareviReport = (src, detail) => window.reports.push([src, detail]);
  editor.addEventListener("input", () => {
    setTimeout(() => { editor.textContent = model; window.hostLog.reverts++; }, 60);
  });
  const { attach } = await import("/src/entry.js");
  window.handle = attach(editor, { editorUrl: "" });
  window.ready = true;
</script>`;

// A host that models one char per delete AND normalizes an emptied block the way Lark does
// (a <br> plus a zero-width span, so the block keeps a caret). That normalization changes
// the text without shortening it — which made a length-based progress test call a finished
// deletion "refused" (2026-11-24, `abcest`).
const NORMALIZING_HOST = `<!doctype html>
<meta charset="utf-8">
<style>#editor{width:520px;min-height:100px;padding:12px 14px;white-space:pre-wrap;outline:none}</style>
<div id="editor" contenteditable="true">test</div>
<script type="module">
  const editor = document.getElementById("editor");
  let model = "test";
  window.hostLog = { model: () => model, paints: 0 };
  window.reports = [];
  globalThis.__jsbareviReport = (src, detail) => window.reports.push([src, detail]);
  const paint = () => {
    editor.innerHTML = model === ""
      ? '<br><span data-zero-space="true">\\u200b</span>'
      : model;
    window.hostLog.paints++;
  };
  editor.addEventListener("input", (e) => {
    const it = String(e.inputType || "");
    if (it === "deleteContentBackward") model = model.slice(0, -1);
    // A replace adopts what the DOM now holds — minus the empty-block placeholder this
    // host paints (a model never contains a zero-width space the viewer cannot see).
    else if (it === "insertText") model = e.data ? model + e.data
      : editor.textContent.replace(/[\u200b]/g, "").replace(/^\\n+$/, "");
    paint();                                  // repaint at once, the way editor-kit does
  });
  const { attach } = await import("/src/entry.js");
  window.handle = attach(editor, { editorUrl: "" });
  window.ready = true;
</script>`;

// A composer padded the way Lark pads its lines: U+200B zero-width spaces as caret anchors,
// plus empty blocks. They are not text, and the engine must never count them — every motion
// and change command was off by the padding before it (2026-11-24).
const PADDED_HOST = `<!doctype html>
<meta charset="utf-8">
<style>#editor{width:520px;min-height:100px;padding:12px 14px;white-space:pre-wrap;outline:none}</style>
<div id="editor" contenteditable="true">test<span data-zero-space="true">\u200b</span></div>
<script type="module">
  const editor = document.getElementById("editor");
  const { attach } = await import("/src/entry.js");
  window.handle = attach(editor, { editorUrl: "" });
  window.ready = true;
</script>`;

// A host that forbids edits which delete text (Lark's editor-kit: it re-inserts whatever we
// remove). The adapter must refuse cleanly — no DOM write, no loop — and say why.
const SEALED_HOST = `<!doctype html>
<meta charset="utf-8">
<style>#editor{width:520px;min-height:100px;padding:12px 14px;white-space:pre-wrap;outline:none}</style>
<div id="editor" contenteditable="true">test</div>
<script type="module">
  globalThis.__jsbareviDestructiveEdits = false;
  window.reports = [];
  globalThis.__jsbareviReport = (src, detail) => window.reports.push([src, detail]);
  const { attach } = await import("/src/entry.js");
  window.handle = attach(document.getElementById("editor"), { editorUrl: "" });
  window.ready = true;
</script>`;

// A host that ignores what we do to the DOM but acts on a key it receives — Lark's
// `editor-kit`, measured 2026-11-24. Declares `destructiveEdits: "keys"`, so the adapter
// must dispatch Backspaces through its own pipeline instead of editing the DOM.
const KEYS_ONLY_HOST = `<!doctype html>
<meta charset="utf-8">
<style>#editor{width:520px;min-height:100px;padding:12px 14px;white-space:pre-wrap;outline:none}</style>
<div id="editor" contenteditable="true">test</div>
<script type="module">
  const editor = document.getElementById("editor");
  let model = "test";
  window.hostLog = { model: () => model, repaints: 0 };
  globalThis.__jsbareviDestructiveEdits = "keys";
  const paint = () => { editor.textContent = model; window.hostLog.repaints++; };
  // It repairs any DOM edit it did not make…
  editor.addEventListener("input", () => { if (editor.textContent !== model) paint(); });
  // …and acts on its own key pipeline.
  editor.addEventListener("keydown", (e) => {
    if (e.key !== "Backspace") return;
    e.preventDefault();
    model = model.slice(0, -1);
    paint();
  }, true);
  const { attach } = await import("/src/entry.js");
  window.handle = attach(editor, { editorUrl: "" });
  window.ready = true;
</script>`;

// A Keep-shaped note: a flat contenteditable with two lines. Used for host edits — a native
// Cut, which the browser performs and the engine has to absorb.
const NOTE_HOST = `<!doctype html>
<meta charset="utf-8">
<style>#editor{width:520px;min-height:100px;padding:12px 14px;white-space:pre-wrap;outline:none}</style>
<div id="editor" contenteditable="true">alpha<br>beta gamma</div>
<script type="module">
  const editor = document.getElementById("editor");
  const { attach } = await import("/src/entry.js");
  window.handle = attach(editor, { editorUrl: "" });
  // Select the first line the way a person does (Shift+Home), then let the BROWSER cut it:
  // delete the range and report it as the host's own edit, which is what a real Cut does.
  window.selectFirstLine = () => {
    const r = document.createRange();
    r.setStart(editor.firstChild, 0);
    r.setEnd(editor.firstChild, 5);              // "alpha"
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    document.dispatchEvent(new Event("selectionchange"));
  };
  // Google Keep's shape, measured in the live app: a native Cut fires the cut event and
  // NOTHING else — no beforeinput, no input — and the host leaves a range behind whose
  // nodes the edit moved, so it keeps painting over the text below.
  // Keep CANCELS the default cut and performs the edit in its own model, so the flag says
  // "the host took this", not "nothing happened" — the adapter must not bail on it.
  editor.addEventListener("cut", (e) => e.preventDefault(), true);
  window.hostCut = () => {
    const sel = getSelection();
    const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    editor.dispatchEvent(new Event("cut", { bubbles: true, cancelable: true }));
    if (range) range.deleteContents();
    const stale = document.createRange();
    stale.setStart(editor.lastChild, 0);
    stale.setEnd(editor.lastChild, 4);
    sel.removeAllRanges();
    sel.addRange(stale);
  };
  window.ready = true;
</script>`;

// A host that hands us the same node twice and later flips contenteditable off (Keep does
// both on every re-render). One adapter per field, and a field that stops being editable
// must not keep projecting ranges into it.
const REATTACH_HOST = `<!doctype html>
<meta charset="utf-8">
<style>#editor{width:520px;min-height:80px;padding:12px;white-space:pre-wrap;outline:none}</style>
<div id="editor" contenteditable="true">test</div>
<script type="module">
  const editor = document.getElementById("editor");
  const { attach } = await import("/src/entry.js");
  window.editor = editor;
  window.first = attach(editor, { editorUrl: "" });
  window.second = attach(editor, { editorUrl: "" });   // the host re-attaches the same node
  window.ready = true;
</script>`;

function serve() {
  const server = createServer((req, res) => {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    if (["/", "/ce", "/model", "/reverting", "/normalizing", "/padded", "/sealed", "/keysonly", "/note", "/reattach"].includes(url)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(url === "/model" ? MODEL_HOST : url === "/reverting" ? REVERTING_HOST
        : url === "/normalizing" ? NORMALIZING_HOST
        : url === "/padded" ? PADDED_HOST
        : url === "/sealed" ? SEALED_HOST
        : url === "/keysonly" ? KEYS_ONLY_HOST
        : url === "/note" ? NOTE_HOST : url === "/reattach" ? REATTACH_HOST : PAGE);
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
    // A DELIBERATE blur is the user clicking away — the adapter only remembers the mode for
    // those (a key-driven blur is usually another extension taking the Escape, and must not
    // be turned back into INSERT).
    await evaluate(page, `(() => {
      const el = document.getElementById("editor");
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      el.blur();
    })()`);
    const afterBlur = await evaluate(page, "JSON.stringify({ mode: window.handle.engine.mode, cursor: window.handle.engine.cursor, under: window.handle.engine.hostText[window.handle.engine.cursor] })");
    check("a blur while inserting steps the cursor left", JSON.parse(afterBlur), { mode: "NORMAL", cursor: beforeBlur - 1, under: "Z" });
    // ...and the field comes back the way it was left: INSERT. A composer that returns
    // in NORMAL turns the next keystroke aimed at the text into a command.
    await evaluate(page, "document.getElementById('editor').focus()");
    await sleep(150);
    check("the mode the field was left in is restored", await evaluate(page, "window.handle.engine.mode"), "INSERT");
    await typeKeys(page, "<Esc>");
    check("an explicit Escape still wins over the restore", await evaluate(page, "window.handle.engine.mode"), "NORMAL");
    await evaluate(page, "document.getElementById('editor').blur()");
    await sleep(120);
    await evaluate(page, "document.getElementById('editor').focus()");
    await sleep(150);
    check("a field left in NORMAL comes back in NORMAL", await evaluate(page, "window.handle.engine.mode"), "NORMAL");

    // ---- visual line ------------------------------------------------------
    await typeKeys(page, "gg");
    const beforeVisual = await text();
    await typeKeys(page, "Vd");
    check("Vd deleted a line", (await text()) !== beforeVisual, true);
    await typeKeys(page, "u");
    check("u restored it", await text(), beforeVisual);

    // ---- :version reports the build --------------------------------------
    await typeKeys(page, ":version<CR>");
    check("status line carries the build", (await evaluate(page, "document.querySelector('.jsbarevi-line').textContent")).startsWith(`jsbarevi ${VERSION}+`), true);
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
    // Insert-mode C-w / C-u in a rich composer.
    //
    // The same two commands one layer up. A real Ctrl-W is the BROWSER's close-tab and
    // Ctrl-U its view-source, so no browser test can press them and still be running —
    // that is why these only earn their keep in a PWA, an Electron window, or a host
    // that dispatches the key itself (OpenCode's composer is exactly that). So the
    // event under test is a cancelable keydown the page dispatches itself, and two
    // things must hold that the textarea test cannot show: the composer's OWN keymap
    // never sees the key, and the host model (rebuilt on `input`) follows the edit.
    // ---------------------------------------------------------------------
    console.log("\n\x1b[1minsert-mode C-w and C-u in a rich composer\x1b[0m");
    await evaluate(page, `(() => {
      const el = document.getElementById('editor');
      el.textContent = "hello world";
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      return true;
    })()`);
    await sleep(60);
    await focus();
    await sleep(30);
    const synthCtrl = (key) => evaluate(page, `(() => {
      window.hostLog.keys.length = 0;
      const ev = new KeyboardEvent('keydown', {
        key: ${JSON.stringify(key)}, bubbles: true, cancelable: true, composed: true, ctrlKey: true,
      });
      document.activeElement.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, hostSaw: window.hostLog.keys.slice() };
    })()`);
    const inputsBefore = (await host()).inputs;
    await typeKeys(page, "A!");
    check("typed at the end of the composer", await text(), "hello world!");
    check("C-w is consumed and the host keymap never sees it", await synthCtrl("w"), { prevented: true, hostSaw: [] });
    check("...and the composer's model follows the edit", await text(), "hello world");
    check("C-u is consumed the same way", await synthCtrl("u"), { prevented: true, hostSaw: [] });
    check("...and with nothing typed it clears the line", await text(), "");
    check("the host was told through an input event", (await host()).inputs > inputsBefore, true);
    await sendKey(page, "Escape");
    check("NORMAL after the deletions", await evaluate(page, "window.handle.engine.mode"), "NORMAL");

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
    // A host that rewrites its own document after an edit.
    //
    // Two shapes and two answers. If only LINE BREAKS differ, the host collapsed a block
    // a change command emptied (`S`/`cc`, or `ciw` on a one-word line) — its line model,
    // not a lost edit, so it is adopted silently. If TEXT differs, something we did not
    // ask for was removed and the status line must say so.
    // ---------------------------------------------------------------------
    console.log("\n\x1b[1ma host that reflows its own blocks\x1b[0m");
    await evaluate(page, `(() => {
      const make = (id, onInput) => {
        const host = document.createElement('div');
        host.id = id;
        host.setAttribute('contenteditable', 'true');
        host.style.cssText = 'width:400px;min-height:80px;white-space:pre-wrap;background:#111;color:#eee;padding:8px';
        host.innerHTML = '<div>alpha beta</div><div>gamma</div>';
        document.body.appendChild(host);
        host.addEventListener('input', onInput);
        window[id] = window.attach(host, { editorUrl: '' });
        return host;
      };
      // (a) Lark-shaped: an emptied block does not survive the host's own render.
      make('reflowing', () => {
        for (const b of [...document.getElementById('reflowing').children]) {
          if (b.tagName === 'DIV' && b.textContent.trim() === '' && document.getElementById('reflowing').children.length > 1) b.remove();
        }
      });
      return true;
    })()`);
    await sleep(80);

    // (a) reflowed: silent, and the engine follows the host's document
    await evaluate(page, "document.getElementById('reflowing').focus()");
    await sleep(60);
    await typeKeys(page, "<Esc>S");
    await sleep(150);
    check("a reflowed block is adopted without a red status",
      /removed more than/.test(await evaluate(page, "(document.querySelector('.jsbarevi-line')||{}).textContent || ''")), false);
    check("...and the engine follows the host's document",
      await evaluate(page, "window.reflowing.engine.hostText"), "gamma");
    // Clean up: this host is a second attachment, and later assertions count the page's
    // overlays.
    await evaluate(page, `(() => { window.reflowing.destroy(); document.getElementById('reflowing').remove(); return true; })()`);

    // The other half of that branch — a host losing TEXT rather than structure — keeps its
    // red status, and is not tested here on purpose: a synthetic host that mutates on
    // `input` is adopted by our own input sync before `_commit` ever compares, so the test
    // would prove nothing. Its real trigger is the unbreakable-element case above.


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

    // ---- a host padded with zero-width placeholders (Lark's shape) --------
    {
      const padPage = await openPage(chromePort, `http://127.0.0.1:${port}/padded`);
      await waitFor(padPage, "!!window.ready", 10000);
      await evaluate(padPage, `document.getElementById("editor").focus()`);
      await sleep(150);
      check("zero-width padding is not characters in the buffer",
        await evaluate(padPage, "window.handle.engine.hostText"), "test");
      await typeKeys(padPage, "<Escape>");
      await sleep(80);
      await typeKeys(padPage, "0");
      await typeKeys(padPage, "C");
      await sleep(300);
      check("...and a change command clears exactly the visible text",
        await evaluate(padPage, "window.handle.engine.hostText.replace(/[\\s\\u200b]/g, '')"), "");
      try { padPage.close(); } catch { /* ignore */ }
    }

    // ---- an Escape must stick even when another extension saw it first ----
    // Another extension blurs the field on Escape (Vimium-style). The blur handler leaves
    // INSERT through the engine and REMEMBERS it as the mode to come back in; our keydown
    // then sees the Escape. If it does not clear that memory, the focus-reclaim walks
    // straight back into INSERT and the user sees "Escape just moves the cursor left".
    {
      const page2 = await openPage(chromePort, `http://127.0.0.1:${port}/ce`);
      await waitFor(page2, "!!window.ready", 10000);
      await evaluate(page2, `document.getElementById("editor").focus()`);
      await sleep(150);
      await typeKeys(page2, "<Escape>");
      await typeKeys(page2, "i");                       // back into INSERT
      await sleep(80);
      const mode = await evaluate(page2, `(() => {
        const el = document.getElementById("editor");
        el.blur();                                      // the other extension blurs first
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true }));
        el.focus();                                     // the focus guard reclaims
        return window.handle.engine.mode;
      })()`);
      check("an Escape that arrived after a blur still lands", mode, "NORMAL");
      try { page2.close(); } catch { /* ignore */ }
    }

    // ---- one adapter per field, and none on a field that stopped being editable ---
    {
      const rePage = await openPage(chromePort, `http://127.0.0.1:${port}/reattach`);
      await waitFor(rePage, "!!window.ready", 10000);
      await sleep(120);
      check("attaching twice to one field leaves ONE adapter",
        await evaluate(rePage, `document.querySelectorAll(".jsbarevi-badge").length`), 1);
      // the host flips it off under us, then reports a selection change
      await evaluate(rePage, `(() => {
        window.editor.setAttribute("contenteditable", "false");
        document.dispatchEvent(new Event("selectionchange"));
      })()`);
      await sleep(120);
      check("...and a field that stops being editable is let go",
        await evaluate(rePage, `document.querySelectorAll(".jsbarevi-badge").length`), 0);
      check("...with its marker removed",
        await evaluate(rePage, `window.editor.hasAttribute("data-jsbarevi-mode")`), false);
      try { rePage.close(); } catch { /* ignore */ }
    }

    // ---- a host edit must not leave the browser's range painted -----------
    // Reported in Google Keep: Shift+Home selects the line, Ctrl-X cuts it, and the
    // highlight stayed on screen — over the text BELOW, because the browser's range still
    // pointed at nodes the cut had moved.
    {
      const notePage = await openPage(chromePort, `http://127.0.0.1:${port}/note`);
      await waitFor(notePage, "!!window.ready", 10000);
      await evaluate(notePage, `document.getElementById("editor").focus()`);
      await sleep(120);
      await evaluate(notePage, "window.selectFirstLine()");
      await sleep(120);
      check("selecting in insert mode becomes visual", await evaluate(notePage, "!!window.handle.engine.visual"), true);
      await evaluate(notePage, "window.hostCut()");
      await sleep(200);
      check("...the cut ends visual mode", await evaluate(notePage, "window.handle.engine.visual"), null);
      check("...the browser selection is COLLAPSED, so nothing stays painted",
        await evaluate(notePage, "getSelection().isCollapsed"), true);
      check("...our own highlight overlay is gone",
        await evaluate(notePage, `document.querySelectorAll(".jsbarevi-sel").length`), 0);
      check("...and the buffer adopted what the host did",
        await evaluate(notePage, "window.handle.engine.hostText"), "\nbeta gamma");
      try { notePage.close(); } catch { /* ignore */ }
    }

    // ---- a host that only accepts edits through its own key pipeline ------
    {
      const keysPage = await openPage(chromePort, `http://127.0.0.1:${port}/keysonly`);
      await waitFor(keysPage, "!!window.ready", 10000);
      await evaluate(keysPage, `document.getElementById("editor").focus()`);
      await sleep(150);
      await typeKeys(keysPage, "<Escape>");
      await sleep(80);
      await typeKeys(keysPage, "0");
      await typeKeys(keysPage, "C");
      await sleep(600);
      check("a keys-only host is edited through its own key pipeline",
        await evaluate(keysPage, `[window.handle.engine.hostText, window.hostLog.model()]`), ["", ""]);
      check("...and the DOM agrees with the host model",
        await evaluate(keysPage, `document.getElementById("editor").innerText`), "");
      try { keysPage.close(); } catch { /* ignore */ }
    }

    // ---- a host that forbids destructive edits (scoped seam) ---------------
    {
      const sealedPage = await openPage(chromePort, `http://127.0.0.1:${port}/sealed`);
      await waitFor(sealedPage, "!!window.ready", 10000);
      await evaluate(sealedPage, `document.getElementById("editor").focus()`);
      await sleep(150);
      await typeKeys(sealedPage, "<Escape>");
      await sleep(80);
      await typeKeys(sealedPage, "0");
      await typeKeys(sealedPage, "C");
      await sleep(300);
      check("a sealed host is told, not fought: status line explains it",
        await evaluate(sealedPage, `document.querySelector(".jsbarevi-line").className.includes("error")`), true);
      check("...the document is untouched", await evaluate(sealedPage, `document.getElementById("editor").innerText`), "test");
      check("...the buffer still agrees with the host", await evaluate(sealedPage, "window.handle.engine.hostText"), "test");
      check("...and it is reported, not silent",
        await evaluate(sealedPage, `window.reports.some((r) => r[0] === "edit-blocked")`), true);
      try { sealedPage.close(); } catch { /* ignore */ }
    }

    // ---- a host with its own document MODEL (Lark's editor-kit) -----------
    //
    // The ranged delete used to be ONE execCommand: right in the DOM, one character in
    // the host's model — which Lark then painted back over the field (2026-11-24). The
    // host here re-renders from its model, so this is the end-to-end check: after `C`
    // both copies must say the same thing, and a re-render must resurrect nothing.
    {
      const modelPage = await openPage(chromePort, `http://127.0.0.1:${port}/model`);
      await waitFor(modelPage, "!!window.ready", 10000);
      await evaluate(modelPage, `document.getElementById("editor").focus()`);
      await sleep(150);
      await typeKeys(modelPage, "<Escape>");
      await sleep(80);
      await typeKeys(modelPage, "0");
      await typeKeys(modelPage, "C");
      await sleep(250);
      check("a modelled host and the engine agree after `C`",
        await evaluate(modelPage, `[window.handle.engine.hostText, window.hostLog.model()]`), ["", ""]);
      await evaluate(modelPage, "window.rerender()");
      await sleep(60);
      check("...so the host's own re-render resurrects nothing",
        await evaluate(modelPage, `document.getElementById("editor").innerText`), "");
      // The first edit may be absorbed (a modelling host repaints it away). That has now
      // taught the adapter this host needs ONE EDIT PER TICK, so the next edit must land.
      await typeKeys(modelPage, "abc");
      await sleep(120);
      await typeKeys(modelPage, "<Escape>");
      await sleep(80);
      await typeKeys(modelPage, "0");
      await typeKeys(modelPage, "C");
      await sleep(500);
      check("a second edit converges, one character per tick",
        await evaluate(modelPage, `[window.handle.engine.hostText, window.hostLog.model()]`), ["", ""]);
      try { modelPage.close(); } catch { /* ignore */ }
    }

    // ---- a host that normalizes the emptied block (Lark's placeholder) ----
    {
      const normPage = await openPage(chromePort, `http://127.0.0.1:${port}/normalizing`);
      await waitFor(normPage, "!!window.ready", 10000);
      await evaluate(normPage, `document.getElementById("editor").focus()`);
      await sleep(150);
      await typeKeys(normPage, "<Escape>");
      await sleep(80);
      await typeKeys(normPage, "0");
      await typeKeys(normPage, "C");
      await sleep(250);
      check("an emptied block that the host normalizes is not a false refusal",
        await evaluate(normPage, `window.reports.some((r) => r[0] === "edit-refused")`), false);
      // The engine's buffer legitimately keeps the host's zero-width placeholder here
      // (Lark leaves one in every empty block), so compare the VISIBLE text.
      check("...the edit still lands: host model and engine agree",
        await evaluate(normPage, `[window.hostLog.model(), window.handle.engine.hostText.replace(/[\\s\\u200b]+/g, "")]`), ["", ""]);
      await typeKeys(normPage, "abc");
      await sleep(200);
      check("...and the field still takes typing, in order",
        await evaluate(normPage, `document.getElementById("editor").innerText`), "abc");
      try { normPage.close(); } catch { /* ignore */ }
    }

    // ---- a host that rewrites over us afterwards --------------------------
    // Adopting the host's text is the difference between a wedged composer and a
    // recoverable one: the engine must never keep a caret the document does not back.
    {
      const revertPage = await openPage(chromePort, `http://127.0.0.1:${port}/reverting`);
      await waitFor(revertPage, "!!window.ready", 10000);
      await evaluate(revertPage, `document.getElementById("editor").focus()`);
      await sleep(150);
      await typeKeys(revertPage, "<Escape>");
      await sleep(80);
      await typeKeys(revertPage, "0");
      await typeKeys(revertPage, "C");
      await sleep(300);
      check("the reverting host really did paint its model back",
        await evaluate(revertPage, "window.hostLog.reverts >= 1"), true);
      check("the engine adopts the text the host really has",
        await evaluate(revertPage, "window.handle.engine.hostText"), "test");
      check("...and reports it instead of failing silently",
        await evaluate(revertPage, `window.reports.some((r) => r[0] === "edit-reverted")`), true);
      try { revertPage.close(); } catch { /* ignore */ }
    }

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
