// The packaged bundle can arrive in ONE page more than once, and that must not become
// two engines on the same field.
//
// The shape under test is the one OpenCode desktop actually produces: for its own
// `oc://` window it cannot use content scripts (Electron rejects a custom scheme in a
// match pattern), so `ext-loader.mjs` concatenates the content scripts of EVERY
// directory under `opencode-desktop-extensions/` into a single page-world bundle and
// evaluates it. A retired copy of this extension kept beside the live one therefore runs
// a second engine on the composer: the first-registered dispatcher eats every key while
// the badge on screen belongs to another copy — "-- INSERT --" over keystrokes that are
// all normal-mode commands. Reported 2026-11-16 as "I cannot type at all".
//
// What this proves:
//   * a duplicate copy stands down (one badge, one engine, one dispatch path)
//   * Esc → i → typing works with a duplicate present
//   * and still works after the field loses and regains focus, which is when the
//     report started
//
//   npm run test:dup        # needs dist/ — `npm run build:ext` first
//
// The engine runs in the page's own world here, so every assertion is page-observable
// (the field's text, the badge), exactly like test/extension-e2e.mjs.

import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sleep, launchChrome, evaluate, waitFor, openPage, typeKeys } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Point at another build to prove the test can fail (a negative control): the shipped
// 0.4.0 predates the one-engine guard, so `JSBAREVI_DIST=<extension dir>` must go red.
const DIST = process.env.JSBAREVI_DIST ? path.resolve(process.env.JSBAREVI_DIST) : path.join(ROOT, "dist");

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>duplicate injection fixture</title>
<style>body{font:16px system-ui;margin:0;padding:24px}
#composer{width:460px;min-height:90px;padding:10px;border:1px solid #888;white-space:pre-wrap;outline:none}
textarea{width:460px;height:80px;font:16px/1.6 monospace}</style>
</head><body>
<div id="composer" contenteditable="true" role="textbox" aria-label="composer">hello composer</div>
<textarea id="field">alpha beta</textarea>
<button id="elsewhere">elsewhere</button>
</body></html>`;

/**
 * The loader's bundle, reproduced from the packaged files.
 *
 * `copies` is how many extension directories the loader found; each contributed its own
 * escape-blocker.js and content.js to the same scope. The `chrome.storage` shim and the
 * `__extInjected` wrapper are the loader's, copied so the settings path is the same one
 * the app takes.
 */
function loaderBundle(copies) {
  const read = (name) => fs.readFileSync(path.join(DIST, name), "utf8");
  const parts = [
    "if (!globalThis.chrome) globalThis.chrome = {};",
    `if (!globalThis.chrome.storage) {
      const read = () => { let s = {}; try { s = JSON.parse(localStorage.getItem("extinject.settings") || "{}") } catch {} return s };
      const backend = {
        get(defaults, cb) { const all = read(); const out = Object.assign({}, defaults || {}); for (const k of Object.keys(defaults || {})) if (all[k] !== undefined) out[k] = all[k]; if (cb) cb(out) },
        set(obj, cb) { const all = read(); Object.assign(all, obj); try { localStorage.setItem("extinject.settings", JSON.stringify(all)) } catch {} if (cb) cb() },
        onChanged: { addListener() {}, removeListener() {} },
      };
      globalThis.chrome.storage = { local: backend, sync: backend, managed: backend, onChanged: backend.onChanged };
    }`,
    "if (!globalThis.__extInjected) { globalThis.__extInjected = true;",
  ];
  for (let i = 0; i < copies; i++) {
    parts.push(`\n;\n// ---- copy ${i + 1}: escape-blocker.js ----\n${read("escape-blocker.js")}\n;\n`);
    parts.push(`\n;\n// ---- copy ${i + 1}: content.js ----\n${read("content.js")}\n;\n`);
  }
  parts.push("\n}");
  return parts.join("");
}

function serve() {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(PAGE);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function run(copies) {
  const server = await serve();
  const port = server.address().port;
  const chromePort = 9800 + Math.floor(Math.random() * 100);
  const { child } = await launchChrome({ port: chromePort });
  const page = await openPage(chromePort, `http://127.0.0.1:${port}/`);
  try {
    await sleep(200);
    await page.send("Runtime.evaluate", { expression: loaderBundle(copies) });
    await sleep(500);

    const state = {
      beforeFocus: null,
      badges: 0,
      attached: 0,
      mode: null,
    };
    state.beforeFocus = await evaluate(page, "document.querySelectorAll('.jsbarevi-badge').length");

    await evaluate(page, "document.getElementById('composer').focus()");
    await sleep(300);
    state.badges = await evaluate(page, "document.querySelectorAll('.jsbarevi-badge').length");
    state.attached = await evaluate(page, "document.querySelectorAll('[data-jsbarevi-active]').length");
    state.mode = await evaluate(page, "document.getElementById('composer').getAttribute('data-jsbarevi-mode')");

    await typeKeys(page, "<Esc>i");
    await sleep(100);
    await typeKeys(page, "ZZZ");
    await sleep(200);
    const baseline = await evaluate(page, "document.getElementById('composer').innerText");

    // The reported sequence: the field loses focus, regains it, and then insert mode is
    // unreachable.
    await evaluate(page, "document.getElementById('elsewhere').focus()");
    await sleep(250);
    await evaluate(page, "document.getElementById('composer').focus()");
    await sleep(250);
    await typeKeys(page, "i");
    await sleep(120);
    const badgeAfterI = await evaluate(page, `(() => { const b = [...document.querySelectorAll('.jsbarevi-badge')].filter(x => x.style.display !== 'none').map(x => x.textContent); return b })()`);
    await typeKeys(page, "QQQ");
    await sleep(250);
    const after = await evaluate(page, "document.getElementById('composer').innerText");

    return { state, baseline, badgeAfterI, after };
  } finally {
    child.kill("SIGKILL");
    server.close();
  }
}

async function main() {
  for (const name of ["content.js", "escape-blocker.js"]) {
    if (!fs.existsSync(path.join(DIST, name))) {
      console.error(`duplicate-injection: dist/${name} is missing — run \`npm run build:ext\` first`);
      process.exit(1);
    }
  }

  console.log("\none copy (the supported shape)");
  const single = await run(1);
  check("one badge", single.state.badges, 1);
  check("Esc i ZZZ types", single.baseline.includes("ZZZ"), true);
  check("after focus loss, i QQQ types", single.after.includes("QQQ"), true);

  console.log("\ntwo copies in one scope (the oc:// injection shape)");
  const double = await run(2);
  check("still ONE engine — one badge", double.state.badges, 1);
  check("one composition root marked active", double.state.attached, 1);
  check("Esc i ZZZ types with a duplicate present", double.baseline.includes("ZZZ"), true);
  check("after focus loss, i QQQ types with a duplicate present", double.after.includes("QQQ"), true);
  check("the visible badge after i is INSERT, not a stale mode", double.badgeAfterI, ["-- INSERT --"]);

  console.log("\nthree copies (a loader with two stale backups)");
  const triple = await run(3);
  check("still ONE engine", triple.state.badges, 1);
  check("Esc i ZZZ types", triple.baseline.includes("ZZZ"), true);
  check("after focus loss, i QQQ types", triple.after.includes("QQQ"), true);

  console.log(`\n${fail === 0 ? "\x1b[32m" : "\x1b[31m"}${pass} passed, ${fail} failed\x1b[0m`);
  process.exit(fail === 0 ? 0 : 1);
}

try {
  main();
} catch (err) {
  console.error("duplicate-injection crashed:", err);
  process.exit(1);
}
