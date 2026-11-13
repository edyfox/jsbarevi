// End-to-end test of the PACKAGED extension: load dist/ as an unpacked extension in
// real headless Chrome, on a page that knows nothing about jsbarevi, and drive it
// with real key events.
//
// Why this exists next to test/e2e-cdp.mjs and not inside it: that harness attaches
// the engine from the page itself, so it can read `window.jsbarevi.<field>.engine`
// for the mode, the cursor and the buffer. Here the engine runs in the extension's
// isolated world and the page cannot see any of it — so every assertion has to be
// observable from the page (the field's value, the `data-jsbarevi-active` marker,
// the badge, the status line). Same browser, different observability, therefore a
// different (smaller) key sender rather than a shared one that pretends otherwise.
//
//   npm run test:ext        # builds dist/ first
//
// What it proves that the other suites cannot:
//   * the bundle is a CLASSIC script and loads as a content script
//   * the manifest's content_scripts / permissions are actually sufficient
//   * settings gate attachment (master switch, per-site disable)
//   * `:e` works through the service-worker transport (no CORS patch anywhere)
//   * `:version` reports the build the package was made from

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

/**
 * Branded Google Chrome (137+) ignores `--load-extension` and
 * `--disable-extensions-except`, so an unpacked extension cannot be loaded that way
 * for a test. Chrome for Testing is the same engine with the flags intact, which is
 * why this suite wants it and test/e2e-cdp.mjs (no extension) does not care.
 * A human loads the same dist/ through chrome://extensions → Load unpacked.
 */
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = path.join(os.homedir(), ".cache", "puppeteer", "chrome");
  if (fs.existsSync(cache)) {
    const builds = fs.readdirSync(cache).sort().reverse();
    for (const build of builds) {
      for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
        const candidate = path.join(cache, build, rel);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  throw new Error("no Chrome for Testing found — set CHROME=/path/to/chrome-for-testing");
}

const CHROME = findChrome();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};
const checkMatch = (name, got, re) => {
  const ok = typeof got === "string" && re.test(got);
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${re}`}`);
  ok ? pass++ : fail++;
};

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>extension fixture</title>
<style>body{font:16px system-ui;margin:0;padding:24px}textarea{width:420px;height:120px;font:16px/1.6 monospace}</style>
</head><body>
<h1>a page that knows nothing about jsbarevi</h1>
<textarea id="field">alpha beta gamma
delta epsilon
zeta eta theta</textarea>
<input id="search" type="text" value="find me">
<input id="secret" type="password" value="hunter2">
<input id="plain" type="number" value="42">
<div data-jsbarevi="off"><textarea id="optedout">leave me alone</textarea></div>
<div id="ce" contenteditable="true">editable prose</div>
</body></html>`;

function serve() {
  const server = createServer((req, res) => {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    if (url === "/edit") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        // an editor session: keep the request open long enough that an idle service
        // worker would be torn down without the pinger (the adapter's flow depends
        // on it), then answer with a visible transformation.
        const body = Buffer.concat(chunks).toString("utf8");
        setTimeout(() => {
          res.writeHead(200, { "content-type": "text/plain", "x-file-changed": "true" });
          res.end(`[from the real editor] ${body.toUpperCase()}`);
        }, 1200);
      });
      return;
    }
    if (url === "/fixture" || url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(PAGE);
      return;
    }
    res.writeHead(404).end("nope");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function launchChrome(port) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "jsbarevi-ext-"));
  const child = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    "about:blank",
  ], { stdio: "ignore" });
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return child;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error("chrome did not start");
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };
  return {
    ready,
    send(method, params = {}) {
      const mid = ++id;
      ws.send(JSON.stringify({ id: mid, method, params }));
      return new Promise((resolve, reject) => pending.set(mid, { resolve, reject }));
    },
    close() { ws.close(); },
  };
}

async function evaluate(session, expression) {
  const r = await session.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || ""));
  return r.result.value;
}

/**
 * Find the extension's own service worker target.
 *
 * Not by url: Chrome ships several component extensions that also use a
 * `background.js` worker (Gemini in Chrome, Contextual Tasks), and picking the first
 * match silently tests somebody else's extension — which is exactly what happened
 * the first time this ran. Identify by the name the worker reports.
 */
async function extensionWorker(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    for (const target of list.filter((t) => t.type === "service_worker")) {
      const probe = cdp(target.webSocketDebuggerUrl);
      try {
        await probe.ready;
        const name = await evaluate(probe, "chrome?.runtime?.getManifest?.()?.name || ''");
        if (/jsbarevi/i.test(name)) {
          await probe.send("Runtime.enable").catch(() => {});
          return { target, session: probe };
        }
      } catch { /* not ours, or it went away */ }
      try { probe.close(); } catch { /* ignore */ }
    }
    await sleep(200);
  }
  throw new Error("the extension's service worker never appeared (manifest error?)");
}

const KEYS = {
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
};

/**
 * One key, from the page's point of view. Insert mode is inferred from the on-screen
 * badge, because that is all a page can see — and if the badge were wrong the
 * behaviour would be wrong too, so it is a fair proxy.
 */
async function sendKey(session, ch) {
  const state = await evaluate(session, `(() => {
    const badge = document.querySelector('.jsbarevi-badge');
    const prompt = document.querySelector('.jsbarevi-prompt');
    return {
      insert: !!badge && /INSERT|REPLACE/.test(badge.textContent || ''),
      prompt: !!prompt && prompt.style.display !== 'none',
    };
  })()`);
  const base = KEYS[ch] || { key: ch, code: /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : ch, keyCode: ch.toUpperCase().charCodeAt(0), text: ch };
  const printable = base.text && ch !== "Escape" && ch !== "Enter";

  if (state.prompt) {
    // the command line is a real input: the browser edits it
    await session.send("Input.dispatchKeyEvent", { type: ch === "Backspace" ? "keyDown" : "rawKeyDown", key: base.key, code: base.code, windowsVirtualKeyCode: base.keyCode, nativeVirtualKeyCode: base.keyCode });
    if (printable) await session.send("Input.dispatchKeyEvent", { type: "char", text: base.text, unmodifiedText: base.text, key: base.key });
    await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: base.key, code: base.code });
    await sleep(20);
    return;
  }

  const alnum = /^[A-Za-z0-9]$/.test(ch);
  await session.send("Input.dispatchKeyEvent", {
    type: ch === "Backspace" ? "keyDown" : "rawKeyDown", key: base.key, code: base.code,
    ...(alnum || ch === "Backspace" ? { windowsVirtualKeyCode: base.keyCode, nativeVirtualKeyCode: base.keyCode } : {}),
  });
  if (state.insert && printable) {
    await session.send("Input.dispatchKeyEvent", { type: "char", text: base.text, unmodifiedText: base.text, key: base.key });
  }
  if (state.insert && ch === "Enter") {
    await session.send("Input.dispatchKeyEvent", { type: "char", text: "\r", unmodifiedText: "\r", key: "Enter" });
  }
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: base.key, code: base.code, windowsVirtualKeyCode: base.keyCode });
  await sleep(18);
}

/** A key sequence in the engine's own notation: `<Esc>`, `<CR>`, `<BS>`, else a char. */
async function typeKeys(session, seq) {
  const named = { "<Esc>": "Escape", "<CR>": "Enter", "<BS>": "Backspace", "<Left>": "ArrowLeft" };
  const parts = [];
  for (let i = 0; i < seq.length;) {
    const m = /^<[A-Za-z]+>/.exec(seq.slice(i));
    if (m) { parts.push(named[m[0]] ?? m[0].slice(1, -1)); i += m[0].length; } else { parts.push(seq[i]); i += 1; }
  }
  for (const p of parts) await sendKey(session, p);
}

const fieldValue = (session, id = "field") => evaluate(session, `document.getElementById('${id}').value`);

async function setSettings(worker, patch) {
  await evaluate(worker, `chrome.storage.local.set(${JSON.stringify(patch)})`);
  await sleep(250); // storage.onChanged -> content script re-read
}

async function openPage(pageSession, port, name) {
  await pageSession.send("Page.navigate", { url: `http://127.0.0.1:${port}/fixture?case=${name}` });
  // document_idle + a bundled ~170 KiB script: wait for the field, not for a clock.
  for (let i = 0; i < 60; i++) {
    try {
      if (await evaluate(pageSession, "!!document.getElementById('field') && document.readyState === 'complete'")) return;
    } catch { /* mid-navigation */ }
    await sleep(100);
  }
  throw new Error("fixture page never finished loading");
}

/** Wait until `expression` evaluates true. Returns the last value either way. */
async function waitFor(pageSession, expression, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await evaluate(pageSession, expression);
      if (last) return last;
    } catch { /* mid-navigation */ }
    await sleep(100);
  }
  return last;
}

async function main() {
  if (!fs.existsSync(path.join(DIST, "manifest.json"))) throw new Error("dist/ is missing — run npm run build:ext first");
  const version = JSON.parse(fs.readFileSync(path.join(DIST, "build.json"), "utf8"));

  const server = await serve();
  const port = server.address().port;
  const chromePort = 9400 + Math.floor(Math.random() * 400);
  const child = await launchChrome(chromePort);
  let page;
  let worker;
  try {
    const target = await (await fetch(`http://127.0.0.1:${chromePort}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/fixture`)}`, { method: "PUT" })).json();
    page = cdp(target.webSocketDebuggerUrl);
    await page.ready;
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Input.setIgnoreInputEvents", { ignore: false }).catch(() => {});

    const found = await extensionWorker(chromePort);
    worker = found.session;
    checkMatch("service worker is the packaged background.js", found.target.url, /^chrome-extension:\/\/[a-p]{32}\/background\.js$/);
    check("the packaged manifest is the one running", await evaluate(worker, "chrome.runtime.getManifest().version"), version.version);
    check("the worker has the storage permission", await evaluate(worker, "typeof chrome.storage.local.get"), "function");

    // Settings before the first focus: a transport is built when a field attaches, so
    // a later change applies to the NEXT attachment (which is the honest behaviour —
    // the endpoint belongs to the session, not to the keystroke).
    await setSettings(worker, { editorUrl: `http://127.0.0.1:${port}/edit` });

    // ---- attach on focus -------------------------------------------------
    await openPage(page, port, "attach");
    await evaluate(page, "document.getElementById('field').focus()");
    check("textarea attached", !!(await waitFor(page, "document.getElementById('field').hasAttribute('data-jsbarevi-active')")), true);
    check("badge exists in the page", await evaluate(page, "!!document.querySelector('.jsbarevi-badge')"), true);
    check("caret is owned by the engine", await evaluate(page, "document.getElementById('field').style.caretColor"), "transparent");

    // ---- normal mode ------------------------------------------------------
    await typeKeys(page, "dw");
    check("dw deletes a word through the packaged engine", await fieldValue(page), "beta gamma\ndelta epsilon\nzeta eta theta");
    await typeKeys(page, "u");
    check("u restores it", await fieldValue(page), "alpha beta gamma\ndelta epsilon\nzeta eta theta");

    // ---- insert mode belongs to the browser -------------------------------
    await typeKeys(page, "i");
    check("i shows INSERT", await evaluate(page, "document.querySelector('.jsbarevi-badge').textContent"), "-- INSERT --");
    await typeKeys(page, "XY<Esc>");
    check("typed text landed at the cursor", await fieldValue(page), "XYalpha beta gamma\ndelta epsilon\nzeta eta theta");
    check("Escape returns to NORMAL", await evaluate(page, "document.querySelector('.jsbarevi-badge').textContent"), "");

    // ---- visual line ------------------------------------------------------
    await typeKeys(page, "Vd");
    check("Vd deletes the line", await fieldValue(page), "delta epsilon\nzeta eta theta");

    // ---- :version tells you which build is running ------------------------
    await typeKeys(page, ":version<CR>");
    checkMatch(":version reports the packaged stamp", await evaluate(page, "document.querySelector('.jsbarevi-line').textContent"), new RegExp(`^jsbarevi 0\\.1\\.0\\+`));

    // ---- :e through the service worker ------------------------------------
    await typeKeys(page, ":e<CR>");
    let afterEdit = "";
    for (let i = 0; i < 40; i++) {
      afterEdit = await fieldValue(page);
      if (afterEdit.startsWith("[from the real editor]")) break;
      await sleep(150);
    }
    checkMatch(":e returned the editor's text (worker transport, no CORS)", afterEdit, /^\[from the real editor\] DELTA EPSILON/);
    if (!/^\[from the real editor\]/.test(afterEdit)) {
      console.log(`       status line: ${JSON.stringify(await evaluate(page, "document.querySelector('.jsbarevi-line').textContent"))}`);
    }

    // ---- eligibility rules ------------------------------------------------
    await openPage(page, port, "eligibility");
    for (const id of ["search", "secret", "plain", "optedout"]) {
      await evaluate(page, `document.getElementById('${id}').focus()`);
      await sleep(200);
    }
    check("text input attaches", await evaluate(page, "document.getElementById('search').hasAttribute('data-jsbarevi-active')"), true);
    check("password field never attaches", await evaluate(page, "document.getElementById('secret').hasAttribute('data-jsbarevi-active')"), false);
    check("number field never attaches", await evaluate(page, "document.getElementById('plain').hasAttribute('data-jsbarevi-active')"), false);
    check("data-jsbarevi=off is honoured", await evaluate(page, "document.getElementById('optedout').hasAttribute('data-jsbarevi-active')"), false);
    check("contenteditable is not claimed yet", await evaluate(page, "document.getElementById('ce').hasAttribute('data-jsbarevi-active')"), false);

    // ---- per-site switch --------------------------------------------------
    await setSettings(worker, { disabledHosts: ["127.0.0.1"] });
    await sleep(300);
    check("disabling the site detaches what is live", await evaluate(page, "document.getElementById('search').hasAttribute('data-jsbarevi-active')"), false);
    check("disabling the site removes the badge", await evaluate(page, "!!document.querySelector('.jsbarevi-badge')"), false);
    await openPage(page, port, "disabled");
    await evaluate(page, "document.getElementById('field').focus()");
    await sleep(300);
    check("a site that is off does not attach", await evaluate(page, "document.getElementById('field').hasAttribute('data-jsbarevi-active')"), false);

    // ---- master switch ----------------------------------------------------
    await setSettings(worker, { disabledHosts: [], enabled: false });
    await openPage(page, port, "master-off");
    await evaluate(page, "document.getElementById('field').focus()");
    await sleep(300);
    check("the master switch stops everything", await evaluate(page, "document.getElementById('field').hasAttribute('data-jsbarevi-active')"), false);

    await setSettings(worker, { enabled: true, disabledHosts: [] });
    await openPage(page, port, "back-on");
    await evaluate(page, "document.getElementById('field').focus()");
    await sleep(300);
    check("and turning it back on re-attaches", await evaluate(page, "document.getElementById('field').hasAttribute('data-jsbarevi-active')"), true);
  } finally {
    try { page?.close(); } catch { /* ignore */ }
    try { worker?.close(); } catch { /* ignore */ }
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
