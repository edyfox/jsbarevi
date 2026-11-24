// Shared CDP plumbing for the extension-level tests and the store screenshot run:
// launch a browser, talk to it over the DevTools protocol, and send real keys.
//
// Split out because THREE callers now need it, and a key sender that exists in three
// places drifts in two of them. test/e2e-cdp.mjs keeps its own copy on purpose: it
// drives the page-world engine and reads `window.jsbarevi.<field>.engine` for the
// mode, while everything here can only see what a PAGE can see (the badge, the
// field's value, the `data-jsbarevi-active` marker). Same browser, different
// observability.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Branded Google Chrome (137+) ignores `--load-extension` and
 * `--disable-extensions-except`, so an unpacked extension cannot be loaded that way.
 * Chrome for Testing is the same engine with the flags intact. A human loads the
 * same directory through chrome://extensions → Load unpacked.
 */
export function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = path.join(os.homedir(), ".cache", "puppeteer", "chrome");
  if (fs.existsSync(cache)) {
    for (const build of fs.readdirSync(cache).sort().reverse()) {
      for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
        const candidate = path.join(cache, build, rel);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  throw new Error("no Chrome for Testing found — set CHROME=/path/to/chrome-for-testing");
}

export async function launchChrome({ port, extraArgs = [], headless = true }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "jsbarevi-chrome-"));
  const args = [
    ...(headless ? ["--headless=new"] : []),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    ...extraArgs,
    "about:blank",
  ];
  const child = spawn(findChrome(), args, { stdio: "ignore" });
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return { child, profile };
    } catch { /* not up yet */ }
    await sleep(100);
  }
  child.kill("SIGKILL");
  throw new Error("chrome did not start");
}

export function cdp(wsUrl) {
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

export async function evaluate(session, expression) {
  const r = await session.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || ""));
  return r.result.value;
}

/** Wait until `expression` is truthy; returns the last value either way. */
export async function waitFor(session, expression, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await evaluate(session, expression);
      if (last) return last;
    } catch { /* mid-navigation */ }
    await sleep(100);
  }
  return last;
}

export async function openPage(port, url) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
  const session = cdp(target.webSocketDebuggerUrl);
  await session.ready;
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("Input.setIgnoreInputEvents", { ignore: false }).catch(() => {});
  return session;
}

/**
 * The extension's own service worker. Identified by the NAME the worker reports, not
 * by its URL: Chrome ships component extensions that also use `background.js`
 * (Gemini in Chrome, Contextual Tasks), and matching on the path tests somebody
 * else's extension.
 */
export async function extensionWorker(port, timeoutMs = 10000) {
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
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
};

/**
 * One key, from the page's point of view. Insert mode is inferred from the on-screen
 * badge, because that is all a page can see — and if the badge were wrong the
 * behaviour would be wrong too, so it is a fair proxy.
 */
export async function sendKey(session, ch) {
  // `C-r`, `C-w`, … : a Ctrl chord. Vi owns Ctrl, and `<C-r>` in insert mode is a
  // command, so the harness has to be able to press one.
  const ctrl = /^C-([a-z])$/.exec(ch);
  if (ctrl) {
    const code = ctrl[1];
    const vk = code.toUpperCase().charCodeAt(0);
    await session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: code, code: `Key${code.toUpperCase()}`, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 2 });
    await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: code, code: `Key${code.toUpperCase()}`, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 2 });
    await sleep(18);
    return;
  }
  // Read the MODE, not the badge: INSERT is deliberately unbadged now (it is the host's
  // own state), so the badge cannot be asked what mode the field is in.
  const state = await evaluate(session, `(() => {
    const mode = document.querySelector('[data-jsbarevi-mode]')?.getAttribute('data-jsbarevi-mode') || '';
    const prompt = document.querySelector('.jsbarevi-prompt');
    return {
      insert: mode === 'INSERT' || mode === 'REPLACE',
      prompt: !!prompt && prompt.style.display !== 'none',
    };
  })()`);
  const base = KEYS[ch] || { key: ch, code: /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : ch, keyCode: ch.toUpperCase().charCodeAt(0), text: ch };
  const printable = base.text && ch !== "Escape" && ch !== "Enter";

  if (state.prompt) {
    // the command line is a real input: the browser edits it
    await session.send("Input.dispatchKeyEvent", {
      type: ch === "Backspace" ? "keyDown" : "rawKeyDown", key: base.key, code: base.code,
      windowsVirtualKeyCode: base.keyCode, nativeVirtualKeyCode: base.keyCode,
    });
    if (printable) await session.send("Input.dispatchKeyEvent", { type: "char", text: base.text, unmodifiedText: base.text, key: base.key });
    await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: base.key, code: base.code });
    await sleep(20);
    return;
  }

  const alnum = /^[A-Za-z0-9]$/.test(ch);
  await session.send("Input.dispatchKeyEvent", {
    type: ch === "Backspace" ? "keyDown" : "rawKeyDown", key: base.key, code: base.code,
    ...(alnum || ch === "Backspace" || ch === "Tab" ? { windowsVirtualKeyCode: base.keyCode, nativeVirtualKeyCode: base.keyCode } : {}),
  });
  if (state.insert && printable) {
    await session.send("Input.dispatchKeyEvent", { type: "char", text: base.text, unmodifiedText: base.text, key: base.key });
  }
  if (state.insert && ch === "Enter") {
    await session.send("Input.dispatchKeyEvent", { type: "char", text: "\r", unmodifiedText: "\r", key: "Enter" });
  }
  await session.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: base.key, code: base.code, windowsVirtualKeyCode: base.keyCode,
  });
  await sleep(18);
}

/** `<Esc>`, `<CR>`, `<BS>`, `<Tab>` are named; everything else is a character. */
export async function typeKeys(session, seq) {
  const named = { "<Esc>": "Escape", "<CR>": "Enter", "<BS>": "Backspace", "<Tab>": "Tab", "<Left>": "ArrowLeft", "<Right>": "ArrowRight" };
  const parts = [];
  for (let i = 0; i < seq.length;) {
    const m = /^<[A-Za-z]+>/.exec(seq.slice(i));
    if (m) { parts.push(named[m[0]] ?? m[0].slice(1, -1)); i += m[0].length; } else { parts.push(seq[i]); i += 1; }
  }
  for (const p of parts) await sendKey(session, p);
}
