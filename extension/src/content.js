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
    try {
      return Promise.resolve(local.get(DEFAULTS))
        .then((got) => ({ ...DEFAULTS, ...(got || {}) }))
        .catch(() => ({ ...DEFAULTS, ...readLocalStorage() }));
    } catch { /* fall through to localStorage */ }
  }
  // The Electron oc:// injected copy has no chrome.storage; it arrives through a
  // localStorage shim and __injectInitial, so read the same value from there.
  return Promise.resolve({ ...DEFAULTS, ...readLocalStorage() });
}

function readLocalStorage() {
  try {
    return JSON.parse(localStorage.getItem("jsbarevi:settings") || "{}") || {};
  } catch { return {}; }
}

function isTextField(el) {
  if (!el || el.nodeType !== 1) return false;
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
  });
  el.setAttribute("data-jsbarevi-active", "");
  active.set(el, handle);
  return handle;
}

function detachAll() {
  for (const [el, handle] of active) {
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
function workerFetch(url, init = {}) {
  const runtime = globalThis.chrome?.runtime;
  if (!runtime?.connect) return fetch(url, init);

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
