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
};

async function sendKey(session, ch) {
  const insert = (await session.send("Runtime.evaluate", {
    expression: "window.jsbarevi.textarea.engine.mode === 'INSERT'",
    returnByValue: true,
  })).result.value;
  const base = KEYS[ch] || { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), text: ch };
  // rawKeyDown never inserts text by itself: the page decides whether the key
  // is consumed. A real browser only produces text when nothing prevented the
  // default action, which is exactly our insert-mode rule.
  const alnum = /^[A-Za-z0-9]$/.test(ch);
  await session.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown", key: base.key, code: base.code,
    ...(alnum ? { windowsVirtualKeyCode: base.keyCode, nativeVirtualKeyCode: base.keyCode } : {}),
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
    const selState = () => evaluate(session, `(() => {
      const el = document.getElementById('field');
      return { start: el.selectionStart, end: el.selectionEnd, focus: document.activeElement.id };
    })()`);
    const box = await evaluate(session, `(() => {
      const r = document.getElementById('field').getBoundingClientRect();
      return { x: Math.round(r.left + 14), y: Math.round(r.top + 16) };
    })()`);
    const plain = await pixelAt(session, box.x, box.y);
    await typeKeys(session, "v");
    const one = await selState();
    check("v selects one character", one.end - one.start, 1);
    check("the field keeps focus so the selection paints", one.focus, "field");
    const highlighted = await pixelAt(session, box.x, box.y);
    check("the highlight is actually painted (pixel changed)", JSON.stringify(highlighted) !== JSON.stringify(plain), true);
    await typeKeys(session, "l");
    const two = await selState();
    check("l extends the visual selection", two.end - two.start, 2);
    await sendKey(session, "Escape");
    const back = await selState();
    check("Esc collapses the selection", back.end - back.start, 0);

    await typeKeys(session, "V");
    const lineSel = await selState();
    check("V selects the whole line (including its newline)", lineSel.end - lineSel.start >= 16, true);
    await sendKey(session, "Escape");

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
  } finally {
    try { session?.close(); } catch {}
    child.kill("SIGKILL");
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error("e2e error:", err); process.exit(2); });
