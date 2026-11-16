// End-to-end test in a real browser: serve the repo, launch headless Chrome,
// attach the extension to a textarea, then dispatch REAL key events and check
// the field's value. This is the layer the unit tests cannot reach: keydown
// interception, insert mode being the browser's, the input-event round trip,
// and committing the engine's text back into the element.
//
// No dependencies: node's http server, node's global WebSocket, CDP directly.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME || "/opt/google/chrome/google-chrome";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

function serve() {
  const server = createServer((req, res) => {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    if (url === "/edit") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`[via editor]\n${body.toUpperCase()}`);
      });
      return;
    }
    const file = path.join(ROOT, url === "/" ? "test/e2e.html" : url);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("nope");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function launchChrome(port) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "jsbarevi-chrome-"));
  const child = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "about:blank",
  ], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return { child, version: await r.json() };
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error("chrome did not start");
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) listeners.forEach((l) => l(msg));
  };
  return {
    ready,
    send(method, params = {}) {
      const mid = ++id;
      ws.send(JSON.stringify({ id: mid, method, params }));
      return new Promise((resolve, reject) => pending.set(mid, { resolve, reject }));
    },
    on(fn) { listeners.push(fn); },
    close() { ws.close(); },
  };
}

const KEYS = {
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

/** A named, non-printable key (arrows, Home/End, PageUp/PageDown). */
async function sendNamedKey(session, name, modifiers = 0) {
  const k = KEYS[name];
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers };
  await session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(15);
}

async function sendKey(session, ch) {
  const ctrl = /^C-([a-z])$/.exec(ch);
  if (ctrl) {
    const k = ctrl[1];
    const vk = k.toUpperCase().charCodeAt(0);
    await session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code: `Key${k.toUpperCase()}`, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 2 });
    await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: `Key${k.toUpperCase()}`, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 2 });
    await sleep(18);
    return;
  }
  const state = (await session.send("Runtime.evaluate", {
    expression: `(() => {
      const el = document.activeElement;
      return {
        insert: window.jsbarevi.textarea.engine.mode === 'INSERT',
        prompt: !!el && el.classList && el.classList.contains('jsbarevi-prompt'),
      };
    })()`,
    returnByValue: true,
  })).result.value;
  const insert = state.insert;
  if (state.prompt) {
    // typing into the command-line input goes through the browser
    const base = KEYS[ch] || { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), text: ch };
    if (ch === "Backspace") {
      // "keyDown" (not raw) lets Chrome apply the input's default edit
      await session.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    } else {
      await session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: base.key, code: base.code });
      if (base.text && ch !== "Escape" && ch !== "Enter") {
        await session.send("Input.dispatchKeyEvent", { type: "char", text: base.text, unmodifiedText: base.text, key: base.key });
      }
    }
    await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: base.key, code: base.code });
    await sleep(20);
    return;
  }
  const base = KEYS[ch] || { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), text: ch };
  // rawKeyDown never inserts text by itself: the page decides whether the key
  // is consumed. A real browser only produces text when nothing prevented the
  // default action, which is exactly our insert-mode rule.
  const alnum = /^[A-Za-z0-9]$/.test(ch);
  // Backspace is the one editing key we send: "keyDown" (not rawKeyDown) is what
  // lets Chrome apply the field's own edit, which is the whole point in insert mode.
  const editKey = ch === "Backspace";
  await session.send("Input.dispatchKeyEvent", {
    type: editKey ? "keyDown" : "rawKeyDown", key: base.key, code: base.code,
    ...(alnum || editKey ? { windowsVirtualKeyCode: base.keyCode, nativeVirtualKeyCode: base.keyCode } : {}),
  });
  const printable = base.text && ch !== "Escape" && ch !== "Enter";
  if (insert && printable) {
    await session.send("Input.dispatchKeyEvent", { type: "char", text: base.text, unmodifiedText: base.text, key: base.key });
  }
  if (insert && ch === "Enter") {
    await session.send("Input.dispatchKeyEvent", { type: "char", text: "\r", unmodifiedText: "\r", key: "Enter" });
  }
  await session.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: base.key, code: base.code, windowsVirtualKeyCode: base.keyCode,
  });
  await sleep(15);
}

async function typeKeys(session, seq) {
  for (const ch of seq) await sendKey(session, ch);
}

/** Real pixel from a screenshot, sampled inside the page itself. */
async function pixelAt(session, x, y) {
  const shot = await session.send("Page.captureScreenshot", { format: "png" });
  return evaluate(session, `(async () => {
    const img = new Image();
    img.src = "data:image/png;base64,${shot.data}";
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(${x}, ${y}, 1, 1).data;
    return [d[0], d[1], d[2]];
  })()`);
}

const evaluate = async (session, expression) => {
  const r = await session.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || ""));
  return r.result.value;
};

async function main() {
  const server = await serve();
  const port = server.address().port;
  const chromePort = 9222 + Math.floor(Math.random() * 500);
  const { child } = await launchChrome(chromePort);
  let session;
  try {
    const target = await (await fetch(`http://127.0.0.1:${chromePort}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/test/e2e.html?editor=/edit`)}`, { method: "PUT" })).json();
    session = cdp(target.webSocketDebuggerUrl);
    await session.ready;
    await session.send("Page.enable");
    await session.send("Runtime.enable");
    await session.send("Input.setIgnoreInputEvents", { ignore: false }).catch(() => {});

    for (let i = 0; i < 100; i++) {
      if (await evaluate(session, "!!window.jsbarevi && window.jsbarevi.ready")) break;
      await sleep(100);
    }
    check("fixture loaded and attached", await evaluate(session, "!!window.jsbarevi.ready"), true);

    const field = () => evaluate(session, "document.getElementById('field').value");
    const mode = () => evaluate(session, "window.jsbarevi.textarea.engine.mode");
    const cursor = () => evaluate(session, "window.jsbarevi.textarea.engine.cursor");

    await evaluate(session, "document.getElementById('field').focus()");
    check("initial buffer", await field(), "alpha beta gamma\ndelta epsilon\nzeta eta theta");

    // --- normal mode, real keydown interception -------------------------
    await typeKeys(session, "j");
    check("j moved to line 2", await evaluate(session, "window.jsbarevi.textarea.engine.cursor"), 17);
    await typeKeys(session, "dd");
    check("dd deleted the line in the DOM", await field(), "alpha beta gamma\nzeta eta theta");
    await typeKeys(session, "u");
    check("u restored it through the adapter", await field(), "alpha beta gamma\ndelta epsilon\nzeta eta theta");

    // --- insert mode belongs to the browser ------------------------------
    await typeKeys(session, "gg");     // deterministic: start on line 1
    await typeKeys(session, "A");
    check("A entered insert mode", await mode(), "INSERT");
    await typeKeys(session, "!");
    await sendKey(session, "Escape");
    check("typed text went through the browser and survived Esc", await field(), "alpha beta gamma!\ndelta epsilon\nzeta eta theta");
    check("Esc returned to normal mode", await mode(), "NORMAL");

    // --- dot repeat after a native insert -------------------------------
    await typeKeys(session, "j0" + ".");
    check(". repeated the insert on the next line", await field(), "alpha beta gamma!\ndelta epsilon!\nzeta eta theta");

    // --- visual mode -----------------------------------------------------
    await typeKeys(session, "gg");
    await typeKeys(session, "wvl");
    await typeKeys(session, "d");
    check("visual + d deleted the selection in the DOM", await field(), "alpha ta gamma!\ndelta epsilon!\nzeta eta theta");

    // --- the `:` line, through the real prompt path ----------------------
    await evaluate(session, "window.jsbarevi.textarea.adapter.finishPrompt('ex', 's/alpha/ALPHA/')");
    check(":s through the adapter's prompt path", await field(), "ALPHA ta gamma!\ndelta epsilon!\nzeta eta theta");

    // --- the block caret: the reason a hairline caret is unusable ---------
    const caret = () => evaluate(session, `(() => {
      const n = document.querySelector('.jsbarevi-caret');
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { display: getComputedStyle(n).display, w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left) };
    })()`);
    await evaluate(session, "document.getElementById('field').focus()");
    await typeKeys(session, "gg");
    const c1 = await caret();
    check("block caret is visible in normal mode", c1 && c1.display !== "none" && c1.w > 0 && c1.h > 8, true);
    const visibleCarets = () => evaluate(session, `[...document.querySelectorAll('.jsbarevi-caret')].filter(n => getComputedStyle(n).display !== 'none').length`);
    check("only the focused field shows a caret", await visibleCarets(), 1);
    check("native caret is hidden in normal mode", await evaluate(session, "getComputedStyle(document.getElementById('field')).caretColor"), "rgba(0, 0, 0, 0)");
    await typeKeys(session, "j");
    const c2 = await caret();
    check("caret follows j to the next line", c2.top - c1.top >= 10, true);
    await typeKeys(session, "i");
    const cInsert = await caret();
    check("caret hides in insert mode", !cInsert || cInsert.display === "none", true);
    check("native caret returns in insert mode", await evaluate(session, "getComputedStyle(document.getElementById('field')).caretColor"), "rgb(238, 238, 238)");
    await sendKey(session, "Escape");

    // --- visual mode must PAINT a highlight, not just hold a range --------
    await typeKeys(session, "gg");
    const boxes = () => evaluate(session, `(() => {
      const out = [];
      for (const n of document.querySelectorAll('.jsbarevi-sel')) {
        if (getComputedStyle(n).display === 'none') continue;
        const r = n.getBoundingClientRect();
        out.push({ w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left) });
      }
      return out;
    })()`);
    const box = await evaluate(session, `(() => {
      const r = document.getElementById('field').getBoundingClientRect();
      return { x: Math.round(r.left + 14), y: Math.round(r.top + 16) };
    })()`);
    const plain = await pixelAt(session, box.x, box.y);
    await typeKeys(session, "v");
    const one = await boxes();
    check("v repaints a visible highlight box", one.length >= 1 && one[0].w > 0 && one[0].h > 8, true);
    const highlighted = await pixelAt(session, box.x, box.y);
    check("the highlight pixel is not the background any more", JSON.stringify(highlighted) !== JSON.stringify(plain), true);
    const widthOne = one[0].w;
    await typeKeys(session, "lll");
    const four = await boxes();
    check("the highlight grows with the selection", four[0].w > widthOne, true);
    await typeKeys(session, "j");
    check("the highlight follows across lines", (await boxes()).length >= 2, true);
    await sendKey(session, "Escape");
    check("Esc clears the highlight", (await boxes()).length, 0);

    await typeKeys(session, "V");
    const lineBoxes = await boxes();
    check("V highlights the whole line", lineBoxes.length >= 1 && lineBoxes[0].w >= 300, true);
    await typeKeys(session, "j");
    check("V extends to a second line", (await boxes()).length >= 2, true);
    await sendKey(session, "Escape");

    // focus moves between fields: the caret must follow
    await evaluate(session, "document.getElementById('single').focus()");
    await sleep(80);
    check("the caret follows focus to the other field", await visibleCarets(), 1);
    check("...and the textarea's caret is gone", await evaluate(session, "document.getElementById('single').closest('body') && getComputedStyle(document.querySelectorAll('.jsbarevi-caret')[0]).display"), "none");
    await evaluate(session, "document.getElementById('field').focus()");

    // --- the command line behaves like vi's -------------------------------
    // Measured against vim, nvi and busybox vi: deleting the typed text but
    // leaving the ":" keeps you in the command line; deleting the ":" exits.
    const promptState = () => evaluate(session, `(() => {
      const p = document.querySelector('.jsbarevi-prompt');
      return {
        visible: p && getComputedStyle(p).display !== 'none',
        value: p ? p.value : null,
        focused: document.activeElement === p,
        enginePrompt: window.jsbarevi.textarea.engine.prompt,
        focusOnField: document.activeElement === document.getElementById('field'),
      };
    })()`);
    await evaluate(session, "document.getElementById('field').focus()");
    await typeKeys(session, ":s/x/y/");
    check("typed text lands in the command line with its sigil", (await promptState()).value, ":s/x/y/");
    for (let i = 0; i < 6; i++) await sendKey(session, "Backspace");
    const onlySigil = await promptState();
    check("deleting the typed text but leaving ':' KEEPS the command line", onlySigil.visible, true);
    check("...and the input now holds only the sigil", onlySigil.value, ":");
    check("...and the engine still owns a prompt", onlySigil.enginePrompt, "ex");
    await sendKey(session, "Backspace");
    const sigilGone = await promptState();
    check("deleting the ':' itself leaves the command line", sigilGone.visible, false);
    check("...focus returns to the field", sigilGone.focusOnField, true);
    check("...the engine has no prompt pending", sigilGone.enginePrompt, null);
    check("...in normal mode", await mode(), "NORMAL");

    // same rule for the search prompt
    await typeKeys(session, "/ab");
    check("'/' opens the search prompt with its sigil", (await promptState()).value, "/ab");
    await sendKey(session, "Backspace");
    await sendKey(session, "Backspace");
    const searchSigilOnly = await promptState();
    check("leaving '/' in the search prompt keeps it open", searchSigilOnly.visible, true);
    check("...holding only the sigil", searchSigilOnly.value, "/");
    await sendKey(session, "Backspace");
    check("deleting '/' leaves the search prompt", (await promptState()).visible, false);

    // '?' keeps its own sigil, so the same rule applies to backward search
    await typeKeys(session, "?");
    check("'?' opens the search prompt with its own sigil", (await promptState()).value, "?");
    await sendKey(session, "Backspace");
    check("deleting '?' leaves it", (await promptState()).visible, false);

    await typeKeys(session, ":");
    await sendKey(session, "Escape");
    check("Esc still cancels", (await promptState()).visible, false);

    await typeKeys(session, ":");
    await session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "c", code: "KeyC", modifiers: 2, windowsVirtualKeyCode: 67 });
    await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: "c", code: "KeyC", modifiers: 2 });
    await sleep(60);
    check("Ctrl-C cancels too, as in vi", (await promptState()).visible, false);

    // --- :e through a TextEditAid-compatible server -----------------------
    const beforeEditor = await field();
    await evaluate(session, "window.jsbarevi.textarea.adapter.finishPrompt('ex', 'e')");
    await sleep(400);
    const afterEditor = await field();
    check(":e round-tripped the buffer through the editor", afterEditor, `[via editor]\n${beforeEditor.toUpperCase()}`);
    check(":e reported what it did",
      (await evaluate(session, "document.querySelector('.jsbarevi-line')?.textContent || ''")).includes("replaced"), true);

    // --- single-line input is attached too -------------------------------
    await evaluate(session, "document.getElementById('single').focus()");
    await typeKeys(session, "0x");
    check("xv on a single-line input", await evaluate(session, "document.getElementById('single').value"), "ingle line input");

    // ---------------------------------------------------------------------
    // Caret keys, the mouse, and native selection vs visual mode.
    //
    // All three are one problem: who owns the caret. The rules (adapted from
    // Input Vim, see src/adapters/textarea.js) are that the ENGINE owns the
    // caret-moving keys vi also has, and the HOST owns the mouse - a click is a
    // caret move we adopt, a drag is a selection we adopt as visual mode.
    // ---------------------------------------------------------------------
    const BUFFER = "alpha beta gamma\ndelta epsilon\nzeta eta theta";
    const resetField = async () => {
      await evaluate(session, `(() => {
        const a = window.jsbarevi.textarea.adapter;
        a.engine.setText(${JSON.stringify(BUFFER)}, 0);
        a._commit();
        a._emitMode();
        document.getElementById('field').focus();
      })()`);
      await sleep(20);
    };
    const caretRect = () => evaluate(session, `(() => {
      const n = document.querySelector('.jsbarevi-caret');
      if (!n || getComputedStyle(n).display === 'none') return null;
      const r = n.getBoundingClientRect();
      return { x: r.left + 2, y: r.top + r.height / 2, left: r.left, top: r.top, h: r.height };
    })()`);
    const clickAt = async (x, y) => {
      await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
      await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
      await sleep(60);
    };
    const dragFromTo = async (from, to) => {
      await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
      const steps = 6;
      for (let i = 1; i <= steps; i++) {
        await session.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: from.x + ((to.x - from.x) * i) / steps,
          y: from.y + ((to.y - from.y) * i) / steps,
          button: "left", buttons: 1,
        });
        await sleep(10);
      }
      await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
      await sleep(80);
    };
    const domSel = () => evaluate(session, `(() => { const el = document.getElementById('field'); return { start: el.selectionStart, end: el.selectionEnd, dir: el.selectionDirection }; })()`);

    console.log("\n\x1b[1mcaret keys own the model outside insert mode\x1b[0m");
    await resetField();
    await typeKeys(session, "gg");
    check("gg starts at the top", await cursor(), 0);
    await sendNamedKey(session, "ArrowRight");
    check("ArrowRight is l", await cursor(), 1);
    await sendNamedKey(session, "ArrowDown");
    check("ArrowDown is j and keeps the column", await cursor(), 18);
    await sendNamedKey(session, "ArrowUp");
    check("ArrowUp is k", await cursor(), 1);
    await sendNamedKey(session, "Home");
    check("Home is 0", await cursor(), 0);
    await sendNamedKey(session, "End");
    check("End is $, on the last character and never past it", await cursor(), 15);
    await sendNamedKey(session, "ArrowRight");
    check("→ at the end of a line stays put (l never crosses the newline)", await cursor(), 15);
    await sendNamedKey(session, "PageDown");
    check("PageDown is C-f and lands on the last line", await cursor(), 31);
    await sendNamedKey(session, "PageUp");
    check("PageUp is C-b", await cursor() < 31, true);
    const writtenBack = await domSel();
    check("the host caret was written back for every move", [writtenBack.start, writtenBack.end], [await cursor(), await cursor()]);
    await typeKeys(session, "x");
    check("a caret-key move edits where the caret is, not where it was", (await field()).length, BUFFER.length - 1);

    console.log("\n\x1b[1mmouse click moves the cursor\x1b[0m");
    await resetField();
    await typeKeys(session, "jj");                       // line 3, col 1 = 31
    const line3 = await caretRect();
    await typeKeys(session, "gg");                       // back to the top
    check("the engine is at the top before the click", await cursor(), 0);
    await clickAt(line3.x, line3.y);
    check("a click on line 3 moves the model there", await cursor(), 31);
    await typeKeys(session, "x");
    check("...and the next command edits at the clicked position", await field(), "alpha beta gamma\ndelta epsilon\neta eta theta");

    console.log("\n\x1b[1mmouse click in insert mode\x1b[0m");
    await resetField();
    await typeKeys(session, "i");
    check("i is insert mode", await mode(), "INSERT");
    const line2 = await (async () => { await sendKey(session, "Escape"); await typeKeys(session, "j0"); const r = await caretRect(); await typeKeys(session, "gg"); await typeKeys(session, "i"); return r; })();
    // click far right on line 2: the DOM caret goes to the end of that line
    await clickAt(line2.left + 560, line2.y);
    const afterClick = await domSel();
    check("the click moved the host caret to the end of line 2", afterClick.start, 30);
    await typeKeys(session, "Q");
    await sendKey(session, "Escape");
    check("typed text landed at the CLICKED position, not the old one", await field(), "alpha beta gamma\ndelta epsilonQ\nzeta eta theta");
    check("Esc leaves the cursor on what was typed", await cursor(), 30);

    console.log("\n\x1b[1ma drag becomes visual mode\x1b[0m");
    await resetField();
    await typeKeys(session, "w");                        // 6: 'b' of beta
    const betaStart = await caretRect();
    await typeKeys(session, "l");
    await typeKeys(session, "l");
    await typeKeys(session, "l");
    await typeKeys(session, "l");                        // 10: the space after beta
    const betaEnd = await caretRect();
    await typeKeys(session, "gg");
    check("normal mode before the drag", await mode(), "NORMAL");
    await dragFromTo(betaStart, betaEnd);
    check("a drag switches the engine to VISUAL", await mode(), "VISUAL");
    check("the anchor is where the drag began", await evaluate(session, "window.jsbarevi.textarea.engine.visual.anchor"), 6);
    check("the head is the live end of the drag", await evaluate(session, "window.jsbarevi.textarea.engine.cursor"), 9);
    check("the engine's selection is the dragged text", await evaluate(session, "window.jsbarevi.textarea.adapter.engine.visualText()"), "beta");
    const afterDrag = await domSel();
    check("the host selection is collapsed again, so only the overlay paints", afterDrag.start === afterDrag.end, true);
    check("the overlay is painting the drag", await evaluate(session, `[...document.querySelectorAll('.jsbarevi-sel')].filter(n => getComputedStyle(n).display !== 'none').length > 0`), true);
    await typeKeys(session, "d");
    check("d deletes exactly what was dragged", await field(), "alpha  gamma\ndelta epsilon\nzeta eta theta");

    console.log("\n\x1b[1mnative selection does not fight visual mode\x1b[0m");
    await resetField();
    await typeKeys(session, "vll");
    check("v is visual", await mode(), "VISUAL");
    const visualSel = await domSel();
    check("engine-driven visual keeps the host selection collapsed", [visualSel.start === visualSel.end, visualSel.start], [true, 2]);
    check("...and paints its own highlight instead", await evaluate(session, `[...document.querySelectorAll('.jsbarevi-sel')].filter(n => getComputedStyle(n).display !== 'none').length > 0`), true);
    await sendNamedKey(session, "ArrowRight");
    check("an arrow EXTENDS the visual selection", await evaluate(session, "window.jsbarevi.textarea.adapter.engine.visualText()"), "alph");
    await sendKey(session, "Escape");
    check("Esc leaves visual and clears the highlight", await evaluate(session, `[...document.querySelectorAll('.jsbarevi-sel')].filter(n => getComputedStyle(n).display !== 'none').length`), 0);
    await sendNamedKey(session, "ArrowRight", 8);        // shift+arrow: a native selection
    check("a shift+arrow selection is adopted as visual too", await mode(), "VISUAL");
    check("...with the host selection collapsed, not doubled", (await domSel()).start === (await domSel()).end, true);
    await sendKey(session, "Escape");
    console.log("\n\x1b[1mshift+click adjusts the selection\x1b[0m");
    const shiftClickAt = async (x, y) => {
      await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1, modifiers: 8 });
      await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1, modifiers: 8 });
      await sleep(60);
    };
    await resetField();
    await typeKeys(session, "gg");
    const atZero = await caretRect();
    await typeKeys(session, "w");                        // 6: 'b' of beta
    const atSix = await caretRect();

    // clicked OUTSIDE the selection: the far end stays, so it grows
    await typeKeys(session, "v");
    await typeKeys(session, "llll");                     // 6..10 = "beta "
    check("the visual selection before the shift+click", await evaluate(session, "window.jsbarevi.textarea.adapter.engine.visualText()"), "beta ");
    await shiftClickAt(atZero.x, atZero.y);              // 0, before the selection
    check("shift+click outside the selection keeps visual mode", await mode(), "VISUAL");
    check("...and grows it, from the click to the far end", await evaluate(session, "window.jsbarevi.textarea.adapter.engine.visualText()"), "alpha beta ");
    const grownSel = await domSel();
    check("...host selection still collapsed", grownSel.start === grownSel.end, true);
    await sendKey(session, "Escape");

    // clicked INSIDE it: a boundary moves to the click, so it shrinks
    await resetField();
    await typeKeys(session, "gg");
    await typeKeys(session, "vllllllll");                // 0..8 = "alpha bet"
    check("the visual selection before the shift+click", await evaluate(session, "window.jsbarevi.textarea.adapter.engine.visualText()"), "alpha bet");
    await shiftClickAt(atSix.x, atSix.y);                // 6, inside, nearer the end
    check("shift+click inside the selection SHRINKS it", await evaluate(session, "window.jsbarevi.textarea.adapter.engine.visualText()"), "alpha b");
    await sendKey(session, "Escape");
    check("...and no text was changed by the gesture", await field(), BUFFER);

    // in normal mode the same gesture starts a selection anchored at the cursor
    await resetField();
    await typeKeys(session, "gg");
    await shiftClickAt(atSix.x, atSix.y);
    check("shift+click in normal mode starts a visual selection", await mode(), "VISUAL");
    check("...anchored at the old cursor and headed at the click", await evaluate(session, "window.jsbarevi.textarea.adapter.engine.visualText()"), "alpha ");
    await sendKey(session, "Escape");
    console.log("\n\x1b[1mundo granularity: one block per change command\x1b[0m");
    // Insert mode is the HOST's here, so this is the layer where the reported bug
    // lived: the deletion and the insert were recorded as two undo steps, and the
    // first `u` only stepped the cursor right.
    await resetField();
    await typeKeys(session, "s");
    check("s deleted the character and is inserting", await mode(), "INSERT");
    await sendKey(session, "Escape");
    check("Esc back to normal", await mode(), "NORMAL");
    await typeKeys(session, "u");
    check("one u puts the character back", await field(), BUFFER);
    check("...and the cursor is where the change began", await cursor(), 0);

    await resetField();
    await typeKeys(session, "s");
    await typeKeys(session, "Q");
    await sendKey(session, "Escape");
    check("s + typed text is in the field", (await field()).startsWith("Qlpha"), true);
    await typeKeys(session, "u");
    check("one u undoes the deletion AND the typed text", await field(), BUFFER);

    await resetField();
    await typeKeys(session, "cw");
    await typeKeys(session, "Z");
    await sendKey(session, "Escape");
    await typeKeys(session, "u");
    check("cw and its insert undo as one change", await field(), BUFFER);

    await resetField();
    await typeKeys(session, "i");
    await sendKey(session, "Escape");
    await typeKeys(session, "x");
    await typeKeys(session, "u");
    check("an empty insert leaves no undo step for u to waste", await field(), BUFFER);

    // ---------------------------------------------------------------------
    // Insert-mode C-w / C-u. These two cannot be dispatched as REAL keys here:
    // Chrome owns Ctrl-W as "close tab" and Ctrl-U as "view source" at the browser
    // level, so a real key event would act on the browser before the page answered —
    // which is exactly why they are only useful in a PWA, an Electron app, or a host
    // that does not reserve them (OpenCode's composer, the primary home). What IS
    // ours to prove is the half the page controls: the handler runs, it edits the
    // field through the adapter, and it calls preventDefault so a host dispatching
    // the key itself does not also act on it.
    // ---------------------------------------------------------------------
    console.log("\n\x1b[1minsert-mode C-w and C-u\x1b[0m");
    const synthCtrlKey = (key) => evaluate(session, `(() => {
      const ev = new KeyboardEvent('keydown', {
        key: ${JSON.stringify(key)}, bubbles: true, cancelable: true, composed: true, ctrlKey: true,
      });
      document.activeElement.dispatchEvent(ev);
      return ev.defaultPrevented;
    })()`);
    await resetField();
    await typeKeys(session, "ggA!");
    check("typed a character at the end of line 1", await field(), "alpha beta gamma!\ndelta epsilon\nzeta eta theta");
    check("C-w is consumed, not left to the browser", await synthCtrlKey("w"), true);
    check("...and deleted the typed run only", await field(), "alpha beta gamma\ndelta epsilon\nzeta eta theta");
    check("a second C-w is consumed too", await synthCtrlKey("w"), true);
    check("...and deleted the previous word", await field(), "alpha beta \ndelta epsilon\nzeta eta theta");
    check("C-u is consumed, not left to the browser", await synthCtrlKey("u"), true);
    check("...and cleared the line it had nothing typed on", await field(), "\ndelta epsilon\nzeta eta theta");
    await sendKey(session, "Escape");
    check("Esc still leaves insert mode afterwards", await mode(), "NORMAL");
    await typeKeys(session, "u");
    check("one u undoes the whole insert with both deletions", await field(), BUFFER);
    console.log("\n\x1b[1mright click: extends in visual mode, menu suppressed there only\x1b[0m");
    const rightClickAt = async (x, y) => {
      await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "right", buttons: 2, clickCount: 1 });
      await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "right", buttons: 0, clickCount: 1 });
      await sleep(60);
    };
    // A synthetic contextmenu tells us whether the page would have shown a menu,
    // without depending on whether headless Chrome pops one.
    const menuSuppressed = () => evaluate(session, `(() => {
      const el = document.getElementById('field');
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    })()`);
    await resetField();
    await typeKeys(session, "gg");
    await typeKeys(session, "w");                        // 6
    await typeKeys(session, "v");
    await typeKeys(session, "llll");                     // 6..10 = "beta "
    await rightClickAt(atZero.x, atZero.y);              // outside, before it
    check("right click extends the selection like shift+click", await evaluate(session, "window.jsbarevi.textarea.adapter.engine.visualText()"), "alpha beta ");
    check("right click keeps visual mode", await mode(), "VISUAL");
    check("the context menu is suppressed while selecting", await menuSuppressed(), true);
    await sendKey(session, "Escape");
    check("...and comes back outside visual mode, which is the escape hatch", await menuSuppressed(), false);
    await rightClickAt(atSix.x, atSix.y);
    check("a right click in normal mode leaves normal mode", await mode(), "NORMAL");
    await sendKey(session, "Escape");
    // ---------------------------------------------------------------------
    // Soft wrap. A screen line is not a buffer line, and the caret has to be
    // measured in screen space: at a wrap boundary the browser keeps the
    // trailing space on the previous row, so a naive mirror measurement puts the
    // block at the row's right edge.
    // ---------------------------------------------------------------------
    console.log("\n\x1b[1msoft wrap: screen-line measurement\x1b[0m");
    const LONG = "This is a test This is a test This is a test This is a test This is a test This is a test This is a test";
    const setupWrap = async () => {
      await evaluate(session, `(() => {
        const el = document.getElementById('field');
        el.style.width = "360px";
        const a = window.jsbarevi.textarea.adapter;
        a.engine.setText(${JSON.stringify(LONG)}, 0);
        a._commit();
        a._emitMode();
        el.focus();
        return true;
      })()`);
      await sleep(50);
    };
    const blockRect = () => evaluate(session, `(() => {
      const n = document.querySelector('.jsbarevi-caret');
      if (!n || getComputedStyle(n).display === 'none') return null;
      const r = n.getBoundingClientRect();
      const e = document.getElementById('field').getBoundingClientRect();
      return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
               fieldLeft: Math.round(e.left), fieldRight: Math.round(e.right), fieldTop: Math.round(e.top) };
    })()`);
    const rowOf = (offset) => evaluate(session, `window.jsbarevi.textarea.adapter.caret.contentPoint(${offset}).y`);
    const points = (from, to) => evaluate(session, `(() => {
      const c = window.jsbarevi.textarea.adapter.caret;
      const out = [];
      for (let i = ${from}; i <= ${to}; i++) { const p = c.contentPoint(i); out.push([i, Math.round(p.x), Math.round(p.y)]); }
      return out;
    })()`);
    await setupWrap();
    const rowEnd = (from = 0) => evaluate(session, `(() => {
      const c = window.jsbarevi.textarea.adapter.caret;
      const text = document.getElementById('field').value;
      const p0 = c.contentPoint(${from});
      let last = ${from};
      for (let i = ${from}; i < text.length; i++) {
        if (Math.abs(c.contentPoint(i).y - p0.y) < p0.height / 2) last = i; else break;
      }
      return last;
    })()`);
    const at0 = await rowEnd(0);
    check("the long line really wraps (more than one row)", await evaluate(session, `(() => {
      const c = window.jsbarevi.textarea.adapter.caret;
      return Math.round(c.contentPoint(${JSON.stringify(LONG)}.length - 1).y) > Math.round(c.contentPoint(0).y);
    })()`), true);

    // The mirror must measure in the FIELD's width. It used to keep a stale width
    // (created at 640px, then the field was set to 360px), so every wrapped offset
    // was measured in the wrong space and the block sat at the row's right edge
    // instead of on its character - the reported rendering bug.
    check("the measuring mirror follows the field's current TEXT width",
      await evaluate(session, `(() => {
        const el = document.getElementById('field');
        const cs = getComputedStyle(el);
        const text = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
        return window.jsbarevi.textarea.adapter.caret._getMirror().style.width === text + "px";
      })()`), true);
    const wrapAt = await evaluate(session, `(() => {
      const c = window.jsbarevi.textarea.adapter.caret;
      const first = c.contentPoint(0);
      for (let i = 1; i < document.getElementById('field').value.length; i++) {
        if (Math.abs(c.contentPoint(i).y - first.y) > first.height / 2) return i;
      }
      return -1;
    })()`);
    await evaluate(session, `(() => { const a = window.jsbarevi.textarea.adapter; a.engine.setText(${JSON.stringify(LONG)}, ${wrapAt}); a._commit(); a._emitMode(); document.getElementById('field').focus(); return true; })()`);
    await sleep(30);
    const boundary = await blockRect();
    check("the block on the first character of a wrapped row is at the row's LEFT",
      boundary.left - boundary.fieldLeft < 40, true);
    check("...and on the second row, not the first", boundary.top > boundary.fieldTop + 15, true);

    console.log("\n\x1b[1mscreen-line keys: Home/End and the arrows\x1b[0m");
    await evaluate(session, `(() => { const a = window.jsbarevi.textarea.adapter; a.engine.setText(${JSON.stringify(LONG)}, 0); a._commit(); a._emitMode(); document.getElementById('field').focus(); return true; })()`);
    await typeKeys(session, "gg");
    await sendNamedKey(session, "End");
    check("End goes to the end of the SCREEN row, as the browser does in insert mode", await cursor(), at0);
    check("...which is not the end of the buffer line", (await cursor()) < LONG.length - 1, true);
    const endBlock = await blockRect();
    check("...and the block is on the first row", endBlock.top < boundary.top, true);
    await typeKeys(session, "0");
    check("0 is still the buffer-line start", await cursor(), 0);
    await typeKeys(session, "$");
    check("$ is still the buffer-line end", await cursor(), LONG.length - 1);
    const dollarBlock = await blockRect();
    // the buffer line ends on the SECOND row, which is also where the wrap boundary
    // was measured - so >= rather than >
    check("...with the block on the last row, inside the field", dollarBlock.top >= boundary.top && dollarBlock.left < dollarBlock.fieldRight, true);
    await typeKeys(session, "0");
    await sendNamedKey(session, "ArrowDown");
    check("ArrowDown is a SCREEN row", await evaluate(session, `(() => Math.round(window.jsbarevi.textarea.adapter.caret.contentPoint(window.jsbarevi.textarea.engine.cursor).y))()`), Math.round(await rowOf(wrapAt)));
    check("...keeping the screen column", await cursor(), await wrapAt);
    await sendNamedKey(session, "ArrowUp");
    check("ArrowUp comes back to the first row", await cursor(), 0);
    await typeKeys(session, "j");
    check("j is still a buffer-line motion: one long line, so it does not move", await cursor(), 0);
    await typeKeys(session, "gj");
    check("gj is the screen-line motion (typed), same as ArrowDown", await cursor(), await wrapAt);
    await typeKeys(session, "gk");
    check("gk is the screen-line motion up", await cursor(), 0);
    await typeKeys(session, "g$");
    check("g$ is End without the key", await cursor(), at0);
    await typeKeys(session, "g0");
    check("g0 is Home without the key", await cursor(), 0);
    console.log("\n\x1b[1mthe mirror measures in the field's own box\x1b[0m");
    // Two things made wrapped text measure in the wrong space: the mirror was given
    // clientWidth (which includes the padding) and it overrode white-space /
    // overflow-wrap instead of copying them. Both are directly checkable.
    const mirrorBox = await evaluate(session, `(() => {
      const el = document.getElementById('field');
      const a = window.jsbarevi.textarea.adapter;
      el.style.width = "300px";
      a.engine.setText("x".repeat(120), 0);
      a._commit(); a._emitMode();
      const cs = getComputedStyle(el);
      const m = a.caret._getMirror();
      const csM = getComputedStyle(m);
      const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      return {
        mirrorWidth: m.style.width,
        fieldTextWidth: el.clientWidth - pad,
        wraps: {
          whiteSpace: [cs.whiteSpace, csM.whiteSpace],
          overflowWrap: [cs.overflowWrap, csM.overflowWrap],
          wordBreak: [cs.wordBreak, csM.wordBreak],
        },
      };
    })()`);
    check("the mirror is as wide as the field's TEXT area, not its clientWidth",
      mirrorBox.mirrorWidth, `${mirrorBox.fieldTextWidth}px`);
    check("white-space is copied from the field, not assumed",
      mirrorBox.wraps.whiteSpace[0], mirrorBox.wraps.whiteSpace[1]);
    check("overflow-wrap is copied from the field, not assumed",
      mirrorBox.wraps.overflowWrap[0], mirrorBox.wraps.overflowWrap[1]);
    check("word-break is copied from the field, not assumed",
      mirrorBox.wraps.wordBreak[0], mirrorBox.wraps.wordBreak[1]);
    // content coordinates start at the CONTENT box: with padding, a border-box origin
    // puts row 0 at y=paddingTop and rounding y/lineHeight calls that row 1, which
    // shifts every screen-row index (H/M/L/C-d compare against viewport()).
    const origin = await evaluate(session, `(() => {
      const a = window.jsbarevi.textarea.adapter;
      const el = document.getElementById('field');
      el.style.padding = "10px";
      a.engine.setText("alpha beta gamma delta epsilon", 0);
      a._commit(); a._emitMode();
      const p = a.caret.contentPoint(0);
      return { x: Math.round(p.x), y: Math.round(p.y) };
    })()`);
    check("content coordinates start at the content box, not the border box", [origin.x, origin.y], [0, 0]);

    console.log("\n\x1b[1mthe mirror lays out like a SINGLE-LINE input\x1b[0m");
    // An <input> renders its value literally - one line, spaces preserved, never
    // wrapped - while its computed white-space says "normal". Copying that made the
    // mirror collapse runs of spaces and wrap long values, so the block was drawn on a
    // line the field does not have.
    const inputProbe = await evaluate(session, `(() => {
      const el = document.getElementById('single');
      const a = window.jsbarevi.single.adapter;
      const long = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twentytwo";
      a.engine.setText(long, 0); a._commit(); a._emitMode(); el.focus();
      const rows = [];
      for (const k of [0, 20, 60, 100, long.length - 1]) {
        const p = a.caret.contentPoint(k);
        rows.push([k, Math.round(p.y)]);
      }
      // and runs of spaces must not collapse
      a.engine.setText("a  b", 0); a._commit(); a._emitMode();
      const x0 = a.caret.contentPoint(0).x, x1 = a.caret.contentPoint(1).x, x2 = a.caret.contentPoint(2).x;
      const x3 = a.caret.contentPoint(3).x;
      return { rows, spaceCells: [Math.round(x1 - x0), Math.round(x2 - x1), Math.round(x3 - x2)],
               mirrorWhiteSpace: getComputedStyle(a.caret._getMirror()).whiteSpace };
    })()`);
    check("every offset of a long input value is on ONE row", [...new Set(inputProbe.rows.map(([, y]) => y))].length, 1);
    check("the mirror uses the input's real layout (pre), not its computed white-space",
      inputProbe.mirrorWhiteSpace, "pre");
    check("two spaces take two cells", inputProbe.spaceCells.slice(0, 2), [inputProbe.spaceCells[0], inputProbe.spaceCells[0]]);

    console.log("\n\x1b[1mhorizontal scrolling: g0/g$/g^ follow the visible window\x1b[0m");
    // With 'wrap' off the screen line is only the VISIBLE part of a long line, so vim's
    // g0/g$/g^ are relative to that window - not to the line, and not to the buffer.
    const hs = await evaluate(session, `(() => {
      const el = document.getElementById('hscroll');
      const a = window.jsbarevi.hscroll.adapter;
      a.engine.setText("0123456789 abcdefghij ABCDEFGHIJ klmnopqrst uvwxyz the quick brown fox jumps over the lazy dog 0123456789 end", 0);
      a._commit(); a._emitMode(); el.focus();
      const wraps = a.wraps();
      const scrollable = el.scrollWidth > el.clientWidth;
      // unscrolled first
      el.scrollLeft = 0;
      a.engine.feed("$");  const dollar = a.engine.cursor;
      a.engine.feed("g"); a.engine.feed("0"); const g0Unscrolled = a.engine.cursor;
      a.engine.feed("g"); a.engine.feed("$"); const gDollarUnscrolled = a.engine.cursor;
      // now scroll far right and ask again
      el.scrollLeft = 300;
      a.engine.feed("g"); a.engine.feed("0"); const g0Scrolled = a.engine.cursor;
      a.engine.feed("g"); a.engine.feed("$"); const gDollarScrolled = a.engine.cursor;
      a.engine.feed("g"); a.engine.feed("^"); const gCaretScrolled = a.engine.cursor;
      const win = a.hscrollWindow();
      return { wraps, scrollable, dollar, g0Unscrolled, gDollarUnscrolled,
               g0Scrolled, gDollarScrolled, gCaretScrolled, win,
               text: el.value, scrollLeft: el.scrollLeft };
    })()`);
    check("the horizontal fixture does not wrap", hs.wraps, false);
    check("...and its line is wider than the field", hs.scrollable, true);
    check("$ is still the END OF THE LINE", hs.dollar, hs.text.length - 1);
    check("g0 unscrolled is the line start", hs.g0Unscrolled, 0);
    check("g$ unscrolled stops at the last VISIBLE character, not the line end",
      hs.gDollarUnscrolled < hs.dollar, true);
    check("g0 scrolled goes to the first character on screen, not the line start",
      hs.g0Scrolled > 0, true);
    check("...which is where the window says it starts", hs.g0Scrolled, hs.win.from);
    check("g$ scrolled stops where the window ends", hs.gDollarScrolled, hs.win.to);
    check("g^ scrolled lands on a non-blank inside the window",
      [hs.gCaretScrolled >= hs.win.from, hs.gCaretScrolled <= hs.win.to], [true, true]);
    check("0 is still the line start regardless of scrolling", await (async () => {
      const r = await evaluate(session, "(() => { const a = window.jsbarevi.hscroll.adapter; a.engine.feed('0'); return a.engine.cursor; })()");
      return r;
    })(), 0);

    // The window must be the TEXT box: clientWidth includes the padding, and using it
    // put g$ about twenty pixels (three characters) past the right edge.
    const edges = await evaluate(session, `(() => {
      const el = document.getElementById('hscroll');
      const a = window.jsbarevi.hscroll.adapter;
      const c = a.caret;
      el.scrollLeft = 300;
      const cs = getComputedStyle(el);
      const padL = parseFloat(cs.paddingLeft), padR = parseFloat(cs.paddingRight);
      const textWidth = el.clientWidth - padL - padR;
      const win = a.hscrollWindow();
      const x = (k) => c.contentPoint(k).x;
      const t = a.engine.text;
      const LF = String.fromCharCode(10);
      const lineEnd = (() => { let i = win.to; while (i < t.length - 1 && t[i] !== LF) i++; return i; })();
      // the window is measured from the CONTENT edge; scrollLeft counts from the
      // padding edge, so the visible range starts at scrollLeft - paddingLeft
      return { win, scrollLeft: el.scrollLeft - padL, textWidth,
        firstX: Math.round(x(win.from)), lastX: Math.round(x(win.to)),
        beforeFirstX: win.from > 0 ? Math.round(x(win.from - 1)) : null,
        afterLastX: win.to < lineEnd ? Math.round(x(win.to + 1)) : null, lineEnd };
    })()`);
    check("the window's first character is at or after the left edge",
      edges.firstX >= edges.scrollLeft - 1, true);
    check("...and the character before it is not", edges.beforeFirstX == null || edges.beforeFirstX < edges.scrollLeft, true);
    check("the window's last character fits inside the TEXT box",
      edges.lastX <= edges.scrollLeft + edges.textWidth + 1, true);
    check("...and the next character does not", edges.afterLastX == null || edges.afterLastX > edges.scrollLeft + edges.textWidth, true);
    const blockInside = await evaluate(session, `(() => {
      const el = document.getElementById('hscroll');
      const a = window.jsbarevi.hscroll.adapter;
      const box = el.getBoundingClientRect();
      const inside = () => {
        const n = [...document.querySelectorAll('.jsbarevi-caret')].find((x) => getComputedStyle(x).display !== 'none');
        if (!n) return null;
        const r = n.getBoundingClientRect();
        return r.left >= box.left - 2 && r.left + r.width <= box.right + 2 &&
               r.top >= box.top - 2 && r.top + r.height <= box.bottom + 2;
      };
      a.engine.feed("g"); a.engine.feed("0"); a._commit(); a._emitMode();
      const atG0 = { inside: inside(), scrollLeft: Math.round(el.scrollLeft) };
      a.engine.feed("g"); a.engine.feed("$"); a._commit(); a._emitMode();
      const atG$ = { inside: inside(), scrollLeft: Math.round(el.scrollLeft) };
      a.engine.feed("$"); a._commit(); a._emitMode();
      const atDollar = { inside: inside(), scrollLeft: Math.round(el.scrollLeft) };
      return { atG0, atG$, atDollar, len: el.value.length };
    })()`);
    check("the block stays inside the field at g0", blockInside.atG0.inside, true);
    check("the block stays inside the field at g$", blockInside.atG$.inside, true);
    check("...even at $, which is off screen to the right", blockInside.atDollar.inside, true);
    check("...because the field scrolled to follow the cursor", blockInside.atDollar.scrollLeft > blockInside.atG0.scrollLeft, true);

    // The drawn block must stay inside the TEXT box: the block has a 1px border, so
    // with content-box its painted box was two pixels wider than the width used to
    // clamp it, and at the end of a long line it spilled into the padding ("a bit too
    // far from the right edge").
    const edgesAfterScroll = await evaluate(session, `(() => {
      const el = document.getElementById('hscroll');
      const a = window.jsbarevi.hscroll.adapter;
      a.engine.setText("alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango", 0);
      a._commit(); a._emitMode(); el.focus();
      const box = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const textLeft = box.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
      const textRight = box.right - (parseFloat(cs.borderRightWidth) || 0) - (parseFloat(cs.paddingRight) || 0);
      const bad = [];
      for (let k = 40; k < 90; k += 5) {
        a.engine.cursor = k; a._commit(); a._emitMode();
        const n = [...document.querySelectorAll('.jsbarevi-caret')].find((x) => getComputedStyle(x).display !== 'none');
        if (!n) { bad.push({ k, why: 'hidden' }); continue; }
        const r = n.getBoundingClientRect();
        if (r.right > textRight + 1 || r.left < textLeft - 1) bad.push({ k, left: Math.round(r.left), right: Math.round(r.right) });
      }
      return { bad, textLeft: Math.round(textLeft), textRight: Math.round(textRight) };
    })()`);
    check("the block never spills into the field's padding", edgesAfterScroll.bad, []);

    console.log("\n\x1b[1mthe cursor is scrolled into view, never left outside\x1b[0m");
    const FORTY_LINES = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    const vertical = await evaluate(session, `(() => {
      const el = document.getElementById('field');
      const a = window.jsbarevi.textarea.adapter;
      const lines = ${JSON.stringify(FORTY_LINES)};
      a.engine.setText(lines, 0); a._commit(); a._emitMode(); el.focus();
      el.scrollTop = 0;
      const t = a.engine.text;
      const lastLineStart = t.lastIndexOf("line ", t.length - 2);
      a.engine.cursor = lastLineStart; a._commit(); a._emitMode();
      const box = el.getBoundingClientRect();
      const n = [...document.querySelectorAll('.jsbarevi-caret')].find((x) => getComputedStyle(x).display !== 'none');
      const r = n ? n.getBoundingClientRect() : null;
      return { scrollTop: Math.round(el.scrollTop),
        blockInside: r ? (r.top >= box.top - 2 && r.top + r.height <= box.bottom + 2) : false,
        hadBlock: !!r };
    })()`);
    check("a cursor far below the viewport scrolls the field", vertical.scrollTop > 0, true);
    check("...and its block is drawn inside the field, not over the page",
      [vertical.hadBlock, vertical.blockInside], [true, true]);

    console.log("\n\x1b[1mno wrapping means a line IS a row: exact, no measurement\x1b[0m");
    // When the field does not wrap, screen rows and buffer lines coincide, so the
    // engine's screen-line machinery reduces to arithmetic. That makes gj == j and the
    // viewport commands exact, and it costs no layout work at all.
    const NOWRAP_TEXT = "abcdef\nghijkl\nmnopqr\nstuvwx\nyzabcd\nefghij";
    const noWrap = await evaluate(session, `(() => {
      const el = document.getElementById('field');
      const a = window.jsbarevi.textarea.adapter;
      const text = ${JSON.stringify(NOWRAP_TEXT)};
      el.style.whiteSpace = "pre";
      el.style.overflowX = "auto";
      a.engine.setText(text, 10);           // line 2, column 3 (0-based)
      a._commit(); a._emitMode(); el.focus();
      const wraps = a.wraps();
      const m = a.metricsFor(10);
      a.engine.feed("g"); a.engine.feed("j");   // gj
      const afterGj = a.engine.cursor;
      a.engine.feed("g"); a.engine.feed("$");   // g$
      const afterG$ = a.engine.cursor;
      a.engine.feed("$");                        // $
      const afterDollar = a.engine.cursor;
      const restored = { wraps, m, afterGj, afterG$, afterDollar };
      el.style.whiteSpace = ""; el.style.overflowX = "";
      a.engine.setText(text, 0); a._commit(); a._emitMode();
      return restored;
    })()`);
    check("a nowrap textarea reports that it does not wrap", noWrap.wraps, false);
    check("its row space is the line number and the column index", [noWrap.m.y, noWrap.m.x, noWrap.m.height], [1, 3, 1]);
    check("gj is j: one buffer line at the same column", noWrap.afterGj, 17);
    check("g$ is $: the end of the line", noWrap.afterG$, noWrap.afterDollar);
    const inputMetrics = await evaluate(session, `(() => {
      const a = window.jsbarevi.single.adapter;
      return { wraps: a.wraps(), hasCaret: !!a.caret };
    })()`);
    check("an <input> never wraps either", inputMetrics.wraps, false);

    console.log("\n\x1b[1mthe mirror follows a style change after attach\x1b[0m");
    const restyle = await evaluate(session, `(() => {
      const el = document.getElementById('field');
      const a = window.jsbarevi.textarea.adapter;
      const long = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen";
      a.engine.setText(long, 0); a._commit(); a._emitMode(); el.focus();
      const before = Math.round(a.caret.contentPoint(long.length - 1).y);
      // the host class changes at runtime: nowrap + horizontal scrolling
      el.style.whiteSpace = "pre";
      el.style.overflowX = "auto";
      a._commit(); a._emitMode();
      const after = Math.round(a.caret.contentPoint(long.length - 1).y);
      const mirror = getComputedStyle(a.caret._getMirror()).whiteSpace;
      el.style.whiteSpace = ""; el.style.overflowX = "";
      a._commit(); a._emitMode();
      return { before, after, mirror };
    })()`);
    check("a wrapping field puts the last character on a later row", restyle.before > 0, true);
    check("switching the field to nowrap moves it to row 0", restyle.after, 0);
    check("...because the mirror re-copied the style", restyle.mirror, "pre");

    console.log("\n\x1b[1ma hanging space belongs to the row it hangs on\x1b[0m");
    // At a soft wrap the field HANGS the space at the end of the row: it has no cell of
    // its own. Measuring the space where it "starts" puts it on the next row, which
    // makes the row's last character look advanceable - and `l` from there appears to
    // land on the SECOND character of the next row.
    const hang = await evaluate(session, `(() => {
      const el = document.getElementById('field');
      const a = window.jsbarevi.textarea.adapter;
      el.style.width = "300px"; el.style.height = "120px"; el.style.overflowY = "";
      // short words, so the fold lands on a SPACE - the reported case: the default
      // wrap is between words.
      const text = "aa bb cc dd ee ff gg hh ii jj kk ll mm nn oo pp qq rr ss tt uu vv ww xx yy zz aaa bbb ccc ddd eee fff";
      a.engine.setText(text, 0); a._commit(); a._emitMode();
      const c = a.caret;
      const p0 = c.contentPoint(0);
      let fold = -1;
      for (let i = 1; i < text.length; i++) {
        if (Math.abs(c.contentPoint(i).y - p0.y) > p0.height / 2) { fold = i; break; }
      }
      const last = c.contentPoint(fold - 1);
      const first = c.contentPoint(fold);
      const second = c.contentPoint(fold + 1);
      return { fold, charBeforeFold: JSON.stringify(text[fold - 1]),
        rowOfLast: Math.round(last.y / last.height), rowOfFirst: Math.round(first.y / first.height),
        xFirst: Math.round(first.x), xSecond: Math.round(second.x),
        xOfLast: Math.round(last.x) };
    })()`);
    check("the character that starts a new row is that row's FIRST cell", hang.xFirst, 0);
    check("...and the row's last character is on the row before", hang.rowOfLast + 1, hang.rowOfFirst);
    check("...with the second character of the row one cell further right",
      hang.xSecond > hang.xFirst, true);
    check("a space at the fold is reported on the row it hangs on",
      hang.charBeforeFold === JSON.stringify(" "),
      hang.charBeforeFold !== JSON.stringify(" ") || hang.rowOfLast === hang.rowOfFirst - 1);

    console.log("\n\x1b[1ma click resets the vertical wish\x1b[0m");
    await setupWrap();
    const yOf = (off) => evaluate(session, `Math.round(window.jsbarevi.textarea.adapter.caret.contentPoint(${off}).y)`);
    const rowOfCur = () => evaluate(session, `Math.round(window.jsbarevi.textarea.adapter.caret.contentPoint(window.jsbarevi.textarea.engine.cursor).y)`);
    const xOf = (off) => evaluate(session, `window.jsbarevi.textarea.adapter.caret.contentPoint(${off}).x`);
    await typeKeys(session, "gg");
    await typeKeys(session, "gj");                 // sets the screen wish
    await typeKeys(session, "gk");
    await typeKeys(session, "g$");                 // and the end-of-row wish
    await typeKeys(session, "gg");
    const clickRowY = await yOf(0);
    const clickPoint = await evaluate(session, `(() => {
      const el = document.getElementById('field');
      const c = window.jsbarevi.textarea.adapter.caret;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const p = c.contentPoint(0);
      return { x: Math.round(r.left + (parseFloat(cs.paddingLeft) || 0) + (c.contentPoint(8).x - p.x) + 2),
               y: Math.round(r.top + (parseFloat(cs.paddingTop) || 0) + p.height / 2) };
    })()`);
    await clickAt(clickPoint.x, clickPoint.y);
    const clickedAt = await cursor();
    check("the click put the cursor inside the first row", clickedAt > 0 && Math.round(await rowOfCur()) === Math.round(clickRowY), true);
    await typeKeys(session, "gj");
    check("gj after a click keeps the CLICKED column, not the pre-click wish",
      Math.round((await xOf(await cursor())) - (await xOf(clickedAt))), 0);
    check("...and it moved to the next row", Math.round(await rowOfCur()) > Math.round(clickRowY), true);

    console.log("\n\x1b[1mviewport commands land on ROWS\x1b[0m");
    await setupWrap();
    await typeKeys(session, "gg");
    const rowY = (off) => evaluate(session, `Math.round(window.jsbarevi.textarea.adapter.caret.contentPoint(${off}).y)`);
    const rowOfCursor = () => evaluate(session, `Math.round(window.jsbarevi.textarea.adapter.caret.contentPoint(window.jsbarevi.textarea.engine.cursor).y)`);
    const firstRowY = await rowY(0);
    await typeKeys(session, "L");
    const lY = await rowOfCursor();
    check("L lands on a later ROW, not on a buffer line", lY > firstRowY, true);
    check("...and not past the window", await evaluate(session, "window.jsbarevi.textarea.adapter.viewport().height > 1"), true);
    await typeKeys(session, "H");
    check("H returns to the top row", await rowOfCursor(), firstRowY);
    await typeKeys(session, "M");
    const mY = await rowOfCursor();
    check("M lands between the two", mY >= firstRowY && mY <= lY, true);

    // :version is the in-field way to tell a stale page from a broken one: it must
    // report the commit the page actually loaded, not just the semver.
    await evaluate(session, "document.getElementById('field').focus()");
    await typeKeys(session, ":");
    await evaluate(session, "window.jsbarevi.textarea.adapter.finishPrompt('ex', 'version')");
    await sleep(30);
    const versionLine = await evaluate(session, "document.querySelector('.jsbarevi-line')?.textContent || ''");
    check(":version reports the build the page loaded",
      /jsbarevi 0\.1\.0\+[0-9a-f]{7}/.test(versionLine), true);
    check("...the same one entry.BUILD exposes", versionLine.includes((await evaluate(session, "window.jsbarevi.build")).replace(/^0\.1\.0\+/, "")), true);

    console.log("\n\x1b[1mreplace mode: R\x1b[0m");
    const REPLACE_TEXT = "alpha beta\ngamma";
    await evaluate(session, `(() => {
      const a = window.jsbarevi.textarea.adapter;
      a.engine.setText(${JSON.stringify(REPLACE_TEXT)}, 0);
      a._commit(); a._emitMode();
      document.getElementById('field').focus();
      return true;
    })()`);
    await typeKeys(session, "R");
    check("R shows the replace badge",
      await evaluate(session, "[...document.querySelectorAll('div,span')].map(n => n.textContent).find(t => t && t.trim().startsWith('--')) || ''"),
      "-- REPLACE --");
    await typeKeys(session, "X");
    check("typing overwrites instead of inserting", await field(), "Xlpha beta\ngamma");
    // vim shows a BLOCK in replace mode: it marks the character about to be eaten,
    // and a beam would say "insert".
    const replaceCaret = await evaluate(session, `(() => {
      const n = document.querySelector('.jsbarevi-caret');
      const shown = n && getComputedStyle(n).display !== 'none';
      return { shown: !!shown, native: getComputedStyle(document.getElementById('field')).caretColor };
    })()`);
    check("replace mode shows the block caret", replaceCaret.shown, true);
    check("...and hides the native beam", replaceCaret.native, "rgba(0, 0, 0, 0)");
    await typeKeys(session, "Y");
    check("and the next character", await field(), "XYpha beta\ngamma");
    await sendKey(session, "Backspace");
    check("Backspace restores the character it replaced", await field(), "Xlpha beta\ngamma");
    await sendKey(session, "Escape");
    check("Esc returns to normal mode's block", await evaluate(session, "getComputedStyle(document.getElementById('field')).caretColor"), "rgba(0, 0, 0, 0)");
    await typeKeys(session, "i");
    check("only plain insert shows the native beam", await evaluate(session, "getComputedStyle(document.getElementById('field')).caretColor"), "rgb(238, 238, 238)");
    await sendKey(session, "Escape");
    await typeKeys(session, "u");
    check("one undo puts the whole replace back", await field(), REPLACE_TEXT);
    // replace never grows a line until it runs out of characters to eat
    await evaluate(session, `(() => {
      const a = window.jsbarevi.textarea.adapter;
      a.engine.setText("ab", 0);
      a._commit(); a._emitMode();
      document.getElementById('field').focus();
      return true;
    })()`);
    await typeKeys(session, "R");
    await typeKeys(session, "Z");
    check("the first character overwrites", await field(), "Zb");
    await typeKeys(session, "W");
    check("the second overwrites the last one", await field(), "ZW");
    await typeKeys(session, "Q");
    check("typing past the end of the line appends", await field(), "ZWQ");
    await sendKey(session, "Escape");

    // ---------------------------------------------------------------------
    // Mode survives a focus loss (focus-mode.js).
    //
    // The composer case: leave the field while inserting, come back, and the next
    // keystroke must still be text. Coming back in NORMAL silently turns `a`, `x` or
    // any letter into a command.
    // ---------------------------------------------------------------------
    console.log("\n\x1b[1mmode survives a focus loss\x1b[0m");
    await evaluate(session, `(() => {
      const a = window.jsbarevi.textarea.adapter;
      a.engine.setText("alpha beta", 0);
      a._commit(); a._emitMode();
      document.getElementById('field').focus();
      return true;
    })()`);
    await typeKeys(session, "iX");
    check("typing while inserting", await field(), "Xalpha beta");
    check("...and the engine says INSERT", await evaluate(session, "window.jsbarevi.textarea.adapter.engine.mode"), "INSERT");
    await evaluate(session, "document.getElementById('field').blur()");
    await sleep(80);
    check("a blur still leaves the engine in NORMAL", await evaluate(session, "window.jsbarevi.textarea.adapter.engine.mode"), "NORMAL");
    check("...and says so on the badge",
      await evaluate(session, "document.querySelector('.jsbarevi-badge').style.display"), "none");
    await evaluate(session, "document.getElementById('field').focus()");
    await sleep(120);
    check("regaining focus restores INSERT", await evaluate(session, "window.jsbarevi.textarea.adapter.engine.mode"), "INSERT");
    check("...the badge says INSERT too",
      await evaluate(session, "document.querySelector('.jsbarevi-badge').textContent"), "-- INSERT --");
    const beforeTypingAfterFocus = (await field()).length;
    await typeKeys(session, "Y");
    check("...so the next keystroke is TEXT, not a command", (await field()).length, beforeTypingAfterFocus + 1);

    // Escape wins over the restore: the user asked to leave insert.
    await sendKey(session, "Escape");
    check("Escape leaves insert", await evaluate(session, "window.jsbarevi.textarea.adapter.engine.mode"), "NORMAL");
    await evaluate(session, "document.getElementById('field').blur()");
    await sleep(80);
    await evaluate(session, "document.getElementById('field').focus()");
    await sleep(120);
    check("a field left in NORMAL comes back in NORMAL", await evaluate(session, "window.jsbarevi.textarea.adapter.engine.mode"), "NORMAL");

    // REPLACE is deliberately not restored: R rebuilds from a snapshot the host may
    // have invalidated while the field was unfocused, so it comes back as NORMAL.
    await evaluate(session, `(() => {
      const a = window.jsbarevi.textarea.adapter;
      a.engine.setText("abc", 0);
      a._commit(); a._emitMode();
      document.getElementById('field').focus();
      return true;
    })()`);
    await typeKeys(session, "R");
    check("R enters REPLACE", await evaluate(session, "!!window.jsbarevi.textarea.adapter.engine.replaceSession"), true);
    await evaluate(session, "document.getElementById('field').blur()");
    await sleep(80);
    await evaluate(session, "document.getElementById('field').focus()");
    await sleep(120);
    check("REPLACE comes back as NORMAL, never as a stale R", await evaluate(session, "window.jsbarevi.textarea.adapter.engine.mode"), "NORMAL");
    await sendKey(session, "Escape");

    // ---------------------------------------------------------------------
    // The system clipboard, through the host cache.
    //
    // The engine is synchronous and the clipboard API is not, so the host keeps a
    // cache. A `paste` event is the one source that is always available
    // synchronously, and our own writes fill it too — both are asserted here,
    // because "the clipboard register works" is exactly the claim that is easy to
    // make and hard to notice when it is false.
    // ---------------------------------------------------------------------
    console.log("\n\x1b[1mthe system clipboard, through the host cache\x1b[0m");
    await resetField();
    await evaluate(session, `(() => {
      const dt = new DataTransfer();
      dt.setData("text/plain", "piped in\\n");
      document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
      return true;
    })()`);
    await sleep(30);
    await typeKeys(session, '"+p');
    check('"+p pastes what the page was told about the clipboard',
      (await field()).includes("piped in"), true);

    // `<C-r>{register}` in insert mode: the most-used route from the clipboard into a
    // field, and the one where an unconsumed Ctrl-R would reload the page instead.
    await resetField();
    await typeKeys(session, '"ayw');
    await typeKeys(session, "i");
    await sendKey(session, "C-r");      // the tokenizer has no <C-x> spelling
    await sendKey(session, "a");
    check("<C-r>{register} inserts through the host", (await field()).startsWith("alpha alpha beta gamma"), true);
    check("...the page did not reload", await evaluate(session, "!!window.jsbarevi"), true);
    check("...and insert mode is still on", await mode(), "INSERT");
    await sendKey(session, "Escape");
    check("...and Escape leaves insert mode afterwards", await mode(), "NORMAL");

    await resetField();
    await typeKeys(session, '"+yy');
    await resetField();
    await typeKeys(session, '"+p');
    check("...and a yank round-trips through the cache", (await field()).startsWith("alpha beta gamma"), true);
    check("...without the unnamed register being confused by it",
      await evaluate(session, "window.jsbarevi.textarea.engine.registers.read().text"), "alpha beta gamma\n");

    // ---------------------------------------------------------------------
    // Ctrl-A / Ctrl-X belong to vi, and to the browser they are "select all" and
    // "cut" — so the only thing worth asserting in a real browser is that they were
    // CONSUMED: the value changes and the field keeps a collapsed selection.
    // ---------------------------------------------------------------------
    console.log("\n\x1b[1mCtrl-A / Ctrl-X are ours, not the browser's\x1b[0m");
    await evaluate(session, `(() => {
      const a = window.jsbarevi.textarea.adapter;
      a.engine.setText("count 41 here\\n", 0);
      a._commit(); a._emitMode();
      document.getElementById('field').focus();
      return true;
    })()`);
    await sleep(40);
    await sendKey(session, "C-a");
    check("Ctrl-A increments instead of selecting the page", await field(), "count 42 here");
    await sendKey(session, "C-x");
    check("Ctrl-X decrements instead of cutting", await field(), "count 41 here");
    const sel = await evaluate(session, "(() => { const f = document.getElementById('field'); return [f.selectionStart, f.selectionEnd]; })()");
    check("...and the field selection stays collapsed", [sel[0], sel[1]], [sel[0], sel[0]]);

    // ---------------------------------------------------------------------
    // The overlay is painted ON the page, so a palette tuned for a dark editor
    // is invisible on a white document (a 35%-alpha green caret over white).
    // The fixture is dark; flipping the page's own colours to light must
    // repaint our chips and caret WITHOUT a reload or a reattach — that is the
    // shape a host re-theming itself has.
    // ---------------------------------------------------------------------
    console.log("\n\x1b[1mthe palette follows the page\x1b[0m");
    const styleOf = (sel, prop) => evaluate(session,
      `getComputedStyle(document.querySelector(${JSON.stringify(sel)})).${prop}`);
    check("a dark page gets the dark chip", await styleOf(".jsbarevi-badge", "backgroundColor"), "rgb(17, 17, 17)");
    check("...and the light-green caret", await styleOf(".jsbarevi-caret", "backgroundColor"), "rgba(166, 226, 46, 0.35)");

    await evaluate(session, `(() => {
      document.body.style.background = "#ffffff";
      document.body.style.color = "#111";
      const f = document.getElementById('field');
      f.style.background = "#ffffff";
      f.style.color = "#111";
      return true;
    })()`);
    await sleep(60);
    check("a light page gets the light chip", await styleOf(".jsbarevi-badge", "backgroundColor"), "rgb(255, 255, 255)");
    check("...and the darker caret", await styleOf(".jsbarevi-caret", "backgroundColor"), "rgba(47, 111, 0, 0.28)");
    check("...with accent text, not the bright green", await styleOf(".jsbarevi-badge", "color"), "rgb(47, 111, 0)");
    check("...and a ring, so a white chip has an edge", /rgba\(0, 0, 0, 0\.16\)/.test(await styleOf(".jsbarevi-badge", "boxShadow")), true);

    // A page that THINKS it is dark can say so, and that overrides the measurement.
    await evaluate(session, `(() => {
      document.getElementById('field').parentElement.setAttribute('data-jsbarevi-theme', 'dark');
      return true;
    })()`);
    await evaluate(session, "document.body.setAttribute('data-theme','x')");
    await sleep(60);
    check("data-jsbarevi-theme overrides the measurement", await styleOf(".jsbarevi-badge", "backgroundColor"), "rgb(17, 17, 17)");

    await evaluate(session, `(() => {
      document.getElementById('field').parentElement.removeAttribute('data-jsbarevi-theme');
      document.body.removeAttribute('data-theme');
      document.body.style.background = "";
      document.body.style.color = "";
      const f = document.getElementById('field');
      f.style.background = "";
      f.style.color = "";
      return true;
    })()`);
    await sleep(60);
    check("removing the override goes back to the page", await styleOf(".jsbarevi-badge", "backgroundColor"), "rgb(17, 17, 17)");
  } finally {
    try { session?.close(); } catch {}
    child.kill("SIGKILL");
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error("e2e error:", err); process.exit(2); });
