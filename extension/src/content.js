// The extension's content script — the only file that knows it is running in a
// browser (or in an Electron host that loads this extension).
//
// Two jobs, and nothing else:
//   1. decide WHETHER and WHEN the engine attaches (settings, per-site opt-out,
//      what counts as a text field)
//   2. supply the one thing a page cannot: a `:e` transport that is not subject to
//      CORS, by routing the request through the service worker (which holds the
//      host permissions).
//
// It is bundled with ../../src into ONE classic script by tools/build-extension.mjs,
// so this same source also runs where there is no `chrome.*` at all: Electron's
// oc:// windows get it injected into the page world, where `chrome.runtime` does
// not exist and the transport degrades to a plain fetch — exactly what a page
// would have got on its own.

import { attach } from "../../src/entry.js";
import { HttpEditorSession } from "../../src/adapters/editor-session.js";

const DEFAULTS = {
  enabled: true,
  disabledHosts: [],
  editorUrl: "http://127.0.0.1:31416/",
};

// <input type> values that carry text and therefore have a selection model.
// Everything else (number, date, color, file, range, checkbox, password) either has
// no selection API at all or is none of our business.
const TEXT_INPUT_TYPES = new Set(["", "text", "search", "url", "tel", "email"]);

let settings = { ...DEFAULTS };
let suspended = false;
/** element -> attach() handle, so a settings change can take effect immediately. */
const active = new Map();

const settingsReady = loadSettings().then((s) => { settings = s; });

function loadSettings() {
  const local = globalThis.chrome?.storage?.local;
  if (local?.get) {
    // Both styles are real: Chrome's MV3 API returns a promise (and also accepts a
    // callback), while the Electron page-world shim is callback-only and returns
    // undefined. Handling one style silently ignores the other — and with the shim
    // that means ignoring the settings the host injected.
    return new Promise((resolve) => {
      let settled = false;
      const done = (got) => {
        if (settled) return;
        settled = true;
        resolve({ ...DEFAULTS, ...(got || {}) });
      };
      try {
        const maybe = local.get(DEFAULTS, (got) => done(got));
        if (maybe && typeof maybe.then === "function") maybe.then(done, () => done(null));
      } catch {
        done(null);
      }
    });
  }
  // No storage API at all: read the same value from localStorage.
  return Promise.resolve({ ...DEFAULTS, ...readLocalStorage() });
}

function readLocalStorage() {
  try {
    return JSON.parse(localStorage.getItem("jsbarevi:settings") || "{}") || {};
  } catch { return {}; }
}

function isTextField(el) {
  if (!el || el.nodeType !== 1) return false;
  // A contenteditable ROOT — the composer case. Its descendants are also
  // `isContentEditable`, and claiming those would put a second engine inside the
  // first one's document, so the attribute is the test.
  if (el.isContentEditable && el.hasAttribute("contenteditable")) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag !== "INPUT") return false;
  return TEXT_INPUT_TYPES.has((el.getAttribute("type") || "").toLowerCase());
}

function isEligible(el) {
  if (!isTextField(el)) return false;
  if (el.disabled || el.readOnly) return false;
  // Our own prompt line is an <input>; attaching an engine to it would mean two
  // engines and a doubled keystroke.
  if (el.hasAttribute("data-jsbarevi-ui")) return false;
  // Per-field and per-subtree opt-out, so a host page whose own editor handles keys
  // (or a field that is not a text field in spirit) can say so.
  if (el.closest?.('[data-jsbarevi="off"]')) return false;
  return true;
}

function hostDisabled() {
  const hosts = settings.disabledHosts || [];
  const host = location.hostname;
  return hosts.includes(host) || (!!location.host && hosts.includes(location.host));
}

function shouldAttach() {
  return !suspended && !!settings.enabled && !hostDisabled();
}

/**
 * Escape means "leave insert mode", never "leave the field".
 *
 * A host can implement Escape as `blur()` — swallowed by the MAIN-world blocker — or,
 * just as commonly, by focusing something else (`other.focus()`, which no blur patch
 * can stop). That second shape looks exactly like "Escape worked, but the field went
 * dead until I pressed another key", because the key that follows lands on the element
 * the host chose.
 *
 * So a consumed Escape opens a short window in which focus is reclaimed if it moves to
 * anything that is not a field we own. A real click is exempt (it sets `pointerAt`
 * first), and the window is short and attempt-capped so a host with a focus loop can
 * never turn into a fight.
 */
let escapeGuardUntil = 0;
let escapeAttempts = 0;
let pointerAt = 0;
const ESCAPE_GUARD_MS = 600;

document.addEventListener("pointerdown", () => { pointerAt = Date.now(); }, true);
document.addEventListener("mousedown", () => { pointerAt = Date.now(); }, true);

function guardEscape(el, handle) {
  const onFocusOut = () => {
    if (Date.now() > escapeGuardUntil) return;
    if (Date.now() - pointerAt < ESCAPE_GUARD_MS) return;      // the user clicked away: let them
    if (escapeAttempts >= 3) return;
    // Decide AFTER the focus settles. Inside focusout, document.activeElement is still
    // the old node (or body) — Chrome has not moved it yet — so an "is the prompt taking
    // focus?" test made here answers wrong, and the guard then stole focus back from our
    // own command line.
    requestAnimationFrame(() => {
      if (!el.isConnected) return;
      if (Date.now() > escapeGuardUntil) return;
      const now = document.activeElement;
      if (now === el) return;
      // Our own prompt owns focus while it is open; reclaiming it would swallow every
      // `:` the user types.
      if (now && now.hasAttribute && now.hasAttribute("data-jsbarevi-ui")) return;
      escapeAttempts++;
      // Say who took it: if a host keeps stealing focus this line names the culprit in
      // the console instead of leaving us guessing from symptoms.
      try {
        console.info(`[jsbarevi] focus reclaimed from ${now ? (now.tagName || "?").toLowerCase() + (now.id ? "#" + now.id : "") : "nowhere"}`);
      } catch { /* no console */ }
      el.focus({ preventScroll: true });
    });
  };
  el.addEventListener("focusout", onFocusOut);
  return () => el.removeEventListener("focusout", onFocusOut);
}

/** One field, one adapter, one UI. Attaching twice would mean two engines. */
function attachField(el) {
  if (active.has(el) || !isEligible(el) || !document.body) return null;
  const handle = attach(el, {
    sessionFactory: (engine) => new HttpEditorSession({
      engine,
      url: settings.editorUrl || DEFAULTS.editorUrl,
      pageUrl: location.href,
      fetchImpl: workerFetch,
    }),
    onKeyConsumed: (key) => {
      if (key !== "Esc") return;
      escapeGuardUntil = Date.now() + ESCAPE_GUARD_MS;
      escapeAttempts = 0;
    },
  });
  handle.releaseFocusGuard = guardEscape(el, handle);
  el.setAttribute("data-jsbarevi-active", "");
  active.set(el, handle);
  return handle;
}

function detachAll() {
  for (const [el, handle] of active) {
    try { handle.releaseFocusGuard?.(); } catch { /* already gone */ }
    try { handle.destroy(); } catch { /* the host may have removed the node */ }
    el.removeAttribute("data-jsbarevi-active");
  }
  active.clear();
}

function onFocusIn(e) {
  // composedPath()[0], not e.target: a field inside a shadow root is retargeted to
  // its host by the time the event reaches the document, and rich composers live in
  // shadow roots.
  const el = e.composedPath?.()[0] ?? e.target;
  if (!isTextField(el)) return;
  settingsReady.then(() => {
    if (shouldAttach()) attachField(el);
  });
}

/**
 * `:e` transport.
 *
 * A content script's fetch is the PAGE's fetch, so it inherits the page's origin
 * and therefore its CORS rules — pyTextFilter answers OPTIONS with 501, so a page
 * cannot talk to it directly. The service worker has the host permissions and no
 * such restriction, so the request goes there. Where there is no worker (Electron's
 * page-world copy) this falls back to a plain fetch.
 */
let seq = 0;

/**
 * Is there a service worker to route through?
 *
 * Asked once: a host can load this extension without ever running an MV3 worker
 * (Electron's `loadExtension` does exactly that), and `connect()` to a worker that
 * will never answer produces a port that hangs instead of an error. So the decision
 * is made by a real round trip, and a failure falls back to a plain fetch.
 */
let workerAlive = null;
function hasWorker() {
  if (workerAlive) return workerAlive;
  workerAlive = new Promise((resolve) => {
    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.sendMessage) { resolve(false); return; }
    try {
      runtime.sendMessage({ type: "jsbarevi:ping" }, (reply) => {
        resolve(!!reply?.ok && !runtime.lastError);
      });
    } catch { resolve(false); }
  });
  return workerAlive;
}

function workerFetch(url, init = {}) {
  return hasWorker().then((alive) => (alive ? portFetch(url, init) : fetch(url, init)));
}

function portFetch(url, init) {
  const runtime = globalThis.chrome.runtime;
  const id = ++seq;
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = runtime.connect({ name: "jsbarevi:fetch" });
    } catch {
      fetch(url, init).then(resolve, reject);
      return;
    }
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearInterval(beat);
      try { port.disconnect(); } catch { /* already gone */ }
      fn(value);
    };
    // A service worker idles out after ~30 s; an editor session can run 15 min. The
    // port is the liveness signal, so keep it warm while the request is in flight.
    const beat = setInterval(() => { try { port.postMessage({ id, ping: true }); } catch { /* done */ } }, 20000);
    port.onMessage.addListener((msg) => {
      if (!msg || msg.id !== id || msg.ping) return;
      if (msg.error) { finish(reject, new Error(msg.error)); return; }
      finish(resolve, new Response(msg.body ?? "", {
        status: msg.status || 200,
        statusText: msg.statusText || "",
        headers: msg.headers || {},
      }));
    });
    port.onDisconnect.addListener(() => finish(reject, new Error("jsbarevi: background worker disconnected")));
    init.signal?.addEventListener?.("abort", () => finish(reject, new Error("aborted")), { once: true });
    port.postMessage({
      id,
      url: String(url),
      method: init.method || "GET",
      headers: init.headers || {},
      body: typeof init.body === "string" ? init.body : undefined,
    });
  });
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

globalThis.chrome?.storage?.onChanged?.addListener?.(() => {
  settingsReady.then(loadSettings).then((next) => {
    settings = next;
    if (!shouldAttach()) detachAll();
  });
});

// A page can suspend the extension for itself (a site with its own modal keymap) by
// dispatching `jsbarevi:suspend` with detail=true.
globalThis.addEventListener?.("jsbarevi:suspend", (e) => {
  suspended = !!(e && e.detail);
  if (suspended) detachAll();
});

document.addEventListener("focusin", onFocusIn, true);

/**
 * The field that already has focus when we arrive.
 *
 * A page can autofocus a field (or a single-page app can restore focus) before a
 * `document_idle` content script exists. No focus event will follow, so without this
 * the extension sits inert until the user clicks away and back — the field looks
 * broken even though the engine is loaded.
 */
function deepActiveElement() {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

settingsReady.then(() => {
  if (!shouldAttach()) return;
  const el = deepActiveElement();
  if (el && isTextField(el)) attachField(el);
});

// The popup asks the page who it is: the host to toggle, and whether an adapter is
// live. Asking the content script avoids the "tabs" permission (and its "read your
// browsing history" warning) entirely — the extension never needs to know a URL it
// is not already running on.
globalThis.chrome?.runtime?.onMessage?.addListener?.((msg, _sender, respond) => {
  if (msg?.type !== "jsbarevi:hello") return;
  respond({
    host: location.hostname,
    authority: location.host,
    attached: active.size,
    enabled: shouldAttach(),
  });
});

// Diagnostics, readable from the isolated world (CDP / devtools console with the
// extension's context selected). The page-visible proof of an attachment is the
// `data-jsbarevi-active` attribute plus the badge element.
globalThis.__jsbarevi = {
  defaults: DEFAULTS,
  textField: isTextField,
  attachedCount: () => active.size,
  settings: () => settings,
  attach: (el) => attachField(el),
  detachAll,
};
