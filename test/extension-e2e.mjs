// End-to-end test of the PACKAGED extension: load dist/ as an unpacked extension in
// real headless Chrome, on a page that knows nothing about jsbarevi, and drive it
// with real key events.
//
// Why this exists next to test/e2e-cdp.mjs and not inside it: that harness attaches
// the engine from the page itself, so it can read `window.jsbarevi.<field>.engine`
// for the mode, the cursor and the buffer. Here the engine runs in the extension's
// isolated world and the page cannot see any of it — so every assertion has to be
// observable from the page (the field's value, the `data-jsbarevi-active` marker,
// the badge, the status line).
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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  sleep, launchChrome, evaluate, waitFor, openPage, extensionWorker, typeKeys,
} from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

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
<div id="ce-wrapper"><div id="ce" contenteditable="true" role="textbox" aria-label="composer">editable prose</div></div>
<button id="elsewhere">elsewhere</button>
<script>
  // Both shapes of the real bug, because they fail differently:
  //   1. keydown -> blur(): a programmatic blur, which preventDefault cannot stop
  //      (the MAIN-world blocker handles this one);
  //   2. keyup -> other.focus(): focus moved away, which no blur patch can stop and
  //      which is what makes the field look "dead until I press another key"
  //      (the escaped-focus guard handles this one).
  window.__escSeen = 0;
  document.getElementById("ce").addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    window.__escSeen++;
    document.getElementById("ce").blur();
  });
  document.getElementById("ce").addEventListener("keyup", (e) => {
    if (e.key !== "Escape") return;
    setTimeout(() => document.getElementById("elsewhere").focus(), 0);
  });
  // A third shape, and the one behind the real report: the app runs its own key driver
  // as a WINDOW-capture listener (chext_driver.js in OpenCode). A listener on document
  // runs after it, sees nothing, and the field is already gone.
  window.__driverSawEsc = 0;
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    window.__driverSawEsc++;
    const wrapper = document.getElementById("ce-wrapper");
    if (wrapper) wrapper.blur();          // blur the WRAPPER, not the field
  }, true);
</script>
</body></html>`;

// A page that focuses its field BEFORE the content script exists — the autofocus
// case, which the extension has to notice on load because no focus event will follow.
const AUTOFOCUS_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>autofocus</title></head>
<body><textarea id="auto">focused during parse</textarea>
<script>document.getElementById('auto').focus();</script>
</body></html>`;

function serve() {
  const server = createServer((req, res) => {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    if (url === "/edit") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        // An editor session: answer slowly enough that an idle service worker would
        // be torn down without the adapter's pinger.
        const body = Buffer.concat(chunks).toString("utf8");
        setTimeout(() => {
          res.writeHead(200, { "content-type": "text/plain", "x-file-changed": "true" });
          res.end(`[from the real editor] ${body.toUpperCase()}`);
        }, 1200);
      });
      return;
    }
    if (url === "/autofocus") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(AUTOFOCUS_PAGE);
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

const fieldValue = (session, id = "field") => evaluate(session, `document.getElementById('${id}').value`);

async function setSettings(worker, patch) {
  await evaluate(worker, `chrome.storage.local.set(${JSON.stringify(patch)})`);
  await sleep(250); // storage.onChanged -> content script re-reads
}

async function goto(page, port, name) {
  await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/fixture?case=${name}` });
  const ok = await waitFor(page, "!!document.getElementById('field') && document.readyState === 'complete'", 8000);
  if (!ok) throw new Error("fixture page never finished loading");
}

async function focusAndAttach(page, id) {
  await evaluate(page, `document.getElementById('${id}').focus()`);
  await waitFor(page, `document.getElementById('${id}').hasAttribute('data-jsbarevi-active')`, 3000);
  return evaluate(page, `document.getElementById('${id}').hasAttribute('data-jsbarevi-active')`);
}

async function main() {
  if (!fs.existsSync(path.join(DIST, "manifest.json"))) throw new Error("dist/ is missing — run npm run build:ext first");
  const version = JSON.parse(fs.readFileSync(path.join(DIST, "build.json"), "utf8"));

  const server = await serve();
  const port = server.address().port;
  const chromePort = 9400 + Math.floor(Math.random() * 400);
  const { child } = await launchChrome({
    port: chromePort,
    extraArgs: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  let page;
  let worker;
  try {
    page = await openPage(chromePort, `http://127.0.0.1:${port}/fixture`);
    await waitFor(page, "!!document.getElementById('field')", 8000);

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
    await goto(page, port, "attach");
    check("textarea attached", await focusAndAttach(page, "field"), true);
    check("badge exists in the page", await evaluate(page, "!!document.querySelector('.jsbarevi-badge')"), true);
    check("caret is owned by the engine", await evaluate(page, "document.getElementById('field').style.caretColor"), "transparent");
    // The overlay CSS must actually apply: hosts with a strict style-src (Electron
    // apps, webviews) refuse an inline <style>, and the badge would then be unstyled.
    check("overlay CSS is in force", await evaluate(page, "getComputedStyle(document.querySelector('.jsbarevi-badge')).position"), "fixed");
    check("the stylesheet is constructable, not an inline <style>", await evaluate(page, "document.adoptedStyleSheets.length > 0 && !document.getElementById('jsbarevi-style')"), true);

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
    checkMatch(":version reports the packaged stamp", await evaluate(page, "document.querySelector('.jsbarevi-line').textContent"), /^jsbarevi 0\.1\.0\+/);

    // ---- :e through the service worker ------------------------------------
    await typeKeys(page, ":e<CR>");
    const afterEdit = await waitFor(page, `(() => {
      const v = document.getElementById('field').value;
      return v.startsWith('[from the real editor]') ? v : '';
    })()`, 8000);
    checkMatch(":e returned the editor's text (worker transport, no CORS)", afterEdit, /^\[from the real editor\] DELTA EPSILON/);
    if (!afterEdit) {
      console.log(`       status line: ${JSON.stringify(await evaluate(page, "document.querySelector('.jsbarevi-line').textContent"))}`);
    }

    // ---- a field that was focused before we existed ------------------------
    await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/autofocus` });
    check("an already-focused field attaches on load", !!(await waitFor(page, "document.getElementById('auto').hasAttribute('data-jsbarevi-active')", 5000)), true);
    check("and it is live straight away", await evaluate(page, "document.getElementById('auto').style.caretColor"), "transparent");

    // ---- eligibility rules ------------------------------------------------
    await goto(page, port, "eligibility");
    await evaluate(page, "document.getElementById('search').focus()");
    await sleep(400);
    check("text input attaches", await evaluate(page, "document.getElementById('search').hasAttribute('data-jsbarevi-active')"), true);
    for (const id of ["secret", "plain", "optedout"]) {
      await evaluate(page, `document.getElementById('${id}').focus()`);
      await sleep(200);
    }
    check("password field never attaches", await evaluate(page, "document.getElementById('secret').hasAttribute('data-jsbarevi-active')"), false);
    check("number field never attaches", await evaluate(page, "document.getElementById('plain').hasAttribute('data-jsbarevi-active')"), false);
    check("data-jsbarevi=off is honoured", await evaluate(page, "document.getElementById('optedout').hasAttribute('data-jsbarevi-active')"), false);
    await evaluate(page, "document.getElementById('ce').focus()");
    check("a contenteditable composer IS claimed", !!(await waitFor(page, "document.getElementById('ce').hasAttribute('data-jsbarevi-active')", 3000)), true);

    // ---- the composer case, end to end through the packaged bundle ---------
    await typeKeys(page, "dw");
    check("a rich composer is editable through the extension", await evaluate(page, "document.getElementById('ce').textContent"), "prose");

    // Escape must return to NORMAL and keep the field, not eject the user. The host's
    // own handler never runs (we consumed the key), and a blur() from anywhere else is
    // swallowed by the MAIN-world blocker.
    await typeKeys(page, "i");
    check("insert mode marks the field", await evaluate(page, "document.getElementById('ce').getAttribute('data-jsbarevi-mode')"), "INSERT");
    await typeKeys(page, "<Esc>");
    check("Escape returns the composer to NORMAL", await evaluate(page, "document.getElementById('ce').getAttribute('data-jsbarevi-mode')"), "NORMAL");
    check("Escape does not reach the host's own Escape handler", await evaluate(page, "window.__escSeen"), 0);
    check("Escape does not reach the app's WINDOW-capture key driver", await evaluate(page, "window.__driverSawEsc"), 0);
    // The host moves focus on keyup (a path we do not, and should not, intercept).
    check("focus is reclaimed after the host moves it", !!(await waitFor(page, "document.activeElement.id === 'ce'", 3000)), true);
    // The user-facing symptom was "the next key does nothing": the FIRST key after
    // Escape must act as NORMAL.
    await typeKeys(page, "x");
    check("the first key after Escape acts as NORMAL", await evaluate(page, "document.getElementById('ce').textContent"), "rose");

    // An app can also re-render the composer on Escape and focus the NEW node: the key
    // that follows then belongs to an element we have never seen. It must still act.
    await evaluate(page, `(() => {
      const el = document.getElementById('ce');
      const clone = el.cloneNode(true);
      el.replaceWith(clone);
      clone.focus();
      return true;
    })()`);
    await typeKeys(page, "x");
    check("a re-rendered composer still takes the first key", await evaluate(page, "document.getElementById('ce').textContent"), "ose");

    // ---- an Escape whose KEYDOWN was swallowed (another extension, a key driver) ----
    // Only the keyup reaches us. Input Vim's fallback: handle Escape on keyup when the
    // keydown never arrived.
    await evaluate(page, "document.getElementById('ce').focus()");
    await waitFor(page, "document.getElementById('ce').hasAttribute('data-jsbarevi-active')", 3000);
    await typeKeys(page, "i");
    check("insert mode marks the field", await evaluate(page, "document.getElementById('ce').getAttribute('data-jsbarevi-mode')"), "INSERT");
    await evaluate(page, `document.getElementById('ce').dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true, composed: true }))`);
    await sleep(100);
    check("an Escape with no keydown still leaves INSERT", await evaluate(page, "document.getElementById('ce').getAttribute('data-jsbarevi-mode')"), "NORMAL");


    // A programmatic blur() is a function call, so no key handler can stop it: the
    // MAIN-world patch is what keeps the field focused.
    await evaluate(page, "document.getElementById('ce').blur()");
    check("the host cannot blur a field we own", await evaluate(page, "document.activeElement === document.getElementById('ce')"), true);

    // …but the patch is scoped by our marker: a field we do not manage keeps its Escape.
    await evaluate(page, "document.getElementById('secret').focus()");
    await evaluate(page, "document.getElementById('secret').blur()");
    check("an unmanaged field keeps native blur", await evaluate(page, "document.activeElement === document.getElementById('secret')"), false);

    // ---- repeated focus theft must not exhaust the guard ------------------
    // The cap exists to stop a focus LOOP; if it never reset, one bad session would
    // leave the extension permanently unable to keep focus ("until I click the box").
    for (let i = 0; i < 6; i++) {
      await evaluate(page, "document.getElementById('elsewhere').focus()");
      await sleep(140);
    }
    check("the guard still reclaims after repeated thefts", await evaluate(page, "document.activeElement.id"), "ce");

    // ---- per-site switch --------------------------------------------------
    await setSettings(worker, { disabledHosts: ["127.0.0.1"] });
    await sleep(200);
    check("disabling the site detaches what is live", await evaluate(page, "document.getElementById('search').hasAttribute('data-jsbarevi-active')"), false);
    check("disabling the site removes the badge", await evaluate(page, "!!document.querySelector('.jsbarevi-badge')"), false);
    await goto(page, port, "disabled");
    check("a site that is off does not attach", await focusAndAttach(page, "field"), false);

    // ---- master switch ----------------------------------------------------
    await setSettings(worker, { disabledHosts: [], enabled: false });
    await goto(page, port, "master-off");
    check("the master switch stops everything", await focusAndAttach(page, "field"), false);

    await setSettings(worker, { enabled: true, disabledHosts: [] });
    await goto(page, port, "back-on");
    check("and turning it back on re-attaches", await focusAndAttach(page, "field"), true);
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
