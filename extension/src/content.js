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
import { pageTheme, refreshTheme } from "../../src/adapters/theme.js";

const DEFAULTS = {
  enabled: true,
  disabledHosts: [],
  editorUrl: "http://127.0.0.1:31416/",
  // "insert" | "normal" — what a freshly attached field starts in. INSERT because a
  // browser input is supposed to accept typing the moment you click it; the vi modes
  // are then one Escape away. (Input Vim calls the same knob startMode.)
  startMode: "insert",
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
/**
 * Diagnostics a person can actually use: every line is prefixed and says what the
 * extension saw, so one Escape plus one key in the tab console explains the behaviour
 * without guesswork. Content-script logs show up in the page's console.
 */
function trace(message) {
  try { console.info(`[jsbarevi] ${message}`); } catch { /* no console */ }
}

function nameOf(node) {
  if (!node) return "nowhere";
  const tag = (node.tagName || "?").toLowerCase();
  const id = node.id ? `#${node.id}` : "";
  const mode = node.getAttribute?.("data-jsbarevi-mode");
  const slot = node.getAttribute?.("data-slot") || node.getAttribute?.("data-component");
  return `${tag}${id}${slot ? `[${slot}]` : ""}${mode ? ` (${mode})` : ""}`;
}

let escapeGuardUntil = 0;
let escapeAttempts = 0;
let escapeAttemptAt = 0;
let pointerAt = 0;
const ESCAPE_GUARD_MS = 1200;

document.addEventListener("pointerdown", () => { pointerAt = Date.now(); }, true);
document.addEventListener("mousedown", () => { pointerAt = Date.now(); }, true);

/** Was there a pointer interaction just now? A click is the user's decision to leave. */
function pointerRecently() { return Date.now() - pointerAt < 400; }

/**
 * Set when our keydown path consumed an Escape, cleared by that Escape's own keyup.
 *
 * A flag rather than a timer: Input Vim pairs the events the same way (`_blocked` is
 * cleared on the matching keyup). A time window is a race — with enough round trips
 * between the two, a real keydown+keyup pair is mistaken for a swallowed keydown.
 */
let escapeKeydownPending = false;
/** Tab is the user walking the form, not a stolen focus. */
let lastTabAt = 0;

/**
 * Focus policy for a field the engine owns — PORTED FROM INPUT VIM
 * (focus-manager.js). Their rule, and the reason it works regardless of who wins the
 * key race: **a focus loss that the user did not click away from is an Escape**, so the
 * engine goes back to NORMAL and the field takes the focus back.
 *
 *   * a pointer press within 300 ms before it → the user's decision, let go
 *   * focus moving to another field we own → that field's focusin takes over
 *   * Tab → the user is moving through the form, let go
 *   * anything else (a key driver, another extension, a framework effect) → leave the
 *     current mode if we are in one, then refocus on the next frame
 *
 * Capped at a few attempts so a host with a focus loop cannot turn this into a fight,
 * and every decision is traced.
 */
function guardEscape(el, handle) {
  const onFocusOut = (e) => {
    // EVERY decision happens after focus settles. Inside `focusout`,
    // document.activeElement is still the old node (or body) in Chrome, so "is another
    // field taking focus?" answered here is answered wrong — and the guard then steals
    // focus back from the element the user actually went to. Cost me two rounds; it is
    // now one rule: read the settled state, then decide.
    const to = e.relatedTarget;
    requestAnimationFrame(() => {
      if (!el.isConnected) return;
      const cur = document.activeElement;
      if (cur === el) return;
      if (cur && cur.hasAttribute && cur.hasAttribute("data-jsbarevi-ui")) return;   // our command line
      if (cur && isTextField(cur)) { trace(`focusout -> ${nameOf(cur)} (another field)`); return; }
      if (pointerRecently()) { trace(`focusout -> ${nameOf(cur)} (pointer, leaving)`); return; }
      if (Date.now() - lastTabAt < 300) { trace(`focusout -> ${nameOf(cur)} (Tab, leaving)`); return; }
      // The cap is per incident, not per session: it exists to stop a focus LOOP, and a
      // session that hit four steals would otherwise go permanently quiet — which is
      // exactly the "it never intercepts Escape again until I click" report.
      if (Date.now() - escapeAttemptAt > 2000) escapeAttempts = 0;
      if (escapeAttempts >= 4) { trace(`focusout -> ${nameOf(cur)} (attempt cap reached)`); return; }

      // The key may never have reached us — that is exactly what a swallowed Escape
      // looks like — so correct the mode here instead of waiting for a key we may
      // never get. PORTED FROM INPUT VIM (focus-manager): a focus loss without a click
      // is an Escape.
      if (handle.engine && handle.engine.mode !== "NORMAL") {
        trace(`focus lost in ${handle.engine.mode} to ${nameOf(cur)}: treating it as Escape`);
        try { handle.escape(); } catch { /* the host may have torn the field down */ }
      }

      escapeAttempts++;
      escapeAttemptAt = Date.now();
      trace(`focus reclaimed from ${nameOf(cur)} (attempt ${escapeAttempts})`);
      el.focus({ preventScroll: true });
    });
  };
  const onFocus = () => { escapeAttempts = 0; };
  el.addEventListener("focusout", onFocusOut);
  el.addEventListener("focus", onFocus);
  return () => {
    el.removeEventListener("focusout", onFocusOut);
    el.removeEventListener("focus", onFocus);
  };
}

/** One field, one adapter, one UI. Attaching twice would mean two engines. */
function attachField(el) {
  if (active.has(el) || !isEligible(el) || !document.body) return null;
  const handle = attach(el, {
    startMode: settings.startMode === "normal" ? "normal" : "insert",
    sessionFactory: (engine) => new HttpEditorSession({
      engine,
      url: settings.editorUrl || DEFAULTS.editorUrl,
      pageUrl: location.href,
      fetchImpl: workerFetch,
    }),
    // The extension owns the key listener (document_start, before any page script) and
    // routes keys here; the adapter must not also register its own.
    keysDispatchedByHost: true,
    onKeyConsumed: (key) => {
      if (key === "composing") {
        // Diagnostic only: a key dropped for composition in NORMAL mode is the "press
        // it twice" shape, and it is silent everywhere else.
        trace("key ignored: isComposing while in NORMAL (would swallow exactly one key)");
        return;
      }
      if (key !== "Esc") return;
      escapeKeydownPending = true;
      trace("Esc consumed (keydown)");
      escapeGuardUntil = Date.now() + ESCAPE_GUARD_MS;
      escapeAttempts = 0;
    },
  });
  escapeAttempts = 0;
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
 * Claim a field the moment a key lands in it.
 *
 * Focus is normally the trigger, but a host can replace the composer node on Escape (a
 * re-render) and focus the new one: focusin fires, our attach is asynchronous, and the
 * key that follows can arrive first and be swallowed — which is indistinguishable from
 * "I have to press a second key". Handing the key straight to the freshly built adapter
 * closes that window, because a listener added during dispatch never sees the event.
 */
function onKeydownClaim(e) {
  const el = e.composedPath?.()[0] ?? e.target;
  if (active.has(el)) return;
  if (!isEligible(el)) {
    // A key landing in an editable we do not own is worth a line: it is what a host
    // re-render looks like from here, and it explains a swallowed keystroke.
    if (el && el.isContentEditable) trace(`key ignored in ${nameOf(el)}: not eligible (mode ${el.getAttribute("contenteditable")})`);
    return;
  }
  settingsReady.then(() => {
    if (!shouldAttach() || active.has(el)) return;
    const handle = attachField(el);
    if (handle) {
      trace(`claimed ${nameOf(el)} on keydown (no focus event had arrived)`);
      handle.keydown(e);
    }
  });
}

/**
 * Deliver keys to the adapter for the field that owns them.
 *
 * This listener has to be installed HERE, at document_start, not per attach: adapters
 * register their own keydown when a field is focused, which is after the page has
 * parsed — so a host's window-capture key driver (OpenCode's chext_driver, any app with
 * a global keymap) would already be registered ahead of us and would see Escape first.
 * A listener registered before the page's scripts cannot be beaten.
 */
function onKeydownDispatch(e) {
  const target = e.composedPath?.()[0] ?? e.target;
  let node = target;
  while (node && node !== document) {
    const handle = active.get(node);
    if (handle) { handle.keydown(e); return; }
    node = node.parentNode;
  }
}

window.addEventListener("keydown", onKeydownDispatch, true);
// Claims an unowned field when a key lands in it first (see the comment there).
window.addEventListener("keydown", onKeydownClaim, true);

/**
 * Escape fallback, on KEYUP.
 *
 * PORTED FROM INPUT VIM (event-interceptor.js): "Escape fallback: if keydown was
 * swallowed by the page, handle Escape on keyup". Another extension (Vimium lives in the
 * same pages and binds Escape) or a host's own key driver can consume the keydown and
 * call stopImmediatePropagation — but the keyup still reaches us. Without this the user
 * sees exactly what was reported: Escape leaves insert mode by way of a blur, and the
 * engine never learns an Escape happened.
 */
window.addEventListener("keyup", (e) => {
  if (e.key !== "Escape") return;
  if (escapeKeydownPending) { escapeKeydownPending = false; return; }   // the keydown path already handled it
  const target = e.composedPath?.()[0] ?? e.target;
  const el = isTextField(target) ? target : deepActiveElement();
  const handle = el ? findHandle(el) : null;
  if (!handle) {
    trace("Escape keyup fallback: no field to apply it to");
    return;
  }
  const changed = handle.escape();
  trace(`Esc via keyup fallback (${changed ? "mode changed" : "nothing to do"})`);
}, true);

/** Trace that an Escape reached us at all — the difference from "never arrived". */
window.addEventListener("keydown", (e) => {
  if (e.key === "Tab") lastTabAt = Date.now();
  if (e.key !== "Escape") return;
  const el = e.composedPath?.()[0] ?? e.target;
  if (isTextField(el)) trace(`Escape reached us (target ${nameOf(el)})`);
}, true);

/** The attach handle owning `el` (or an ancestor of it). */
function findHandle(el) {
  let node = el;
  while (node && node !== document) {
    const handle = active.get(node);
    if (handle) return handle;
    node = node.parentNode;
  }
  return null;
}

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
  // The palette follows the page, and a host that re-themes without touching <html> or
  // <body> (a framework swapping a stylesheet, a shell we injected into) can ask for a
  // re-measure instead of waiting for the next focus.
  theme: (el) => pageTheme(el),
  refreshTheme,
};
