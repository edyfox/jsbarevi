// Entry point: attach the engine to fields and provide the minimal UI
// (mode badge, one-line status, prompt line). No framework, no build step.

import { TextareaAdapter } from "./adapters/textarea.js";
import { ContenteditableAdapter } from "./adapters/contenteditable.js";
import { bindTheme } from "./adapters/theme.js";
import { systemClipboard } from "./adapters/clipboard.js";

/**
 * Which adapter owns this element.
 *
 * A contenteditable ROOT is the element carrying the attribute; its descendants are
 * also `isContentEditable`, and attaching to those would put a second engine inside
 * the first one's document.
 */
function adapterFor(el) {
  if (el.isContentEditable && el.hasAttribute("contenteditable")) return ContenteditableAdapter;
  return TextareaAdapter;
}

const OVERLAY_CSS = `
.jsbarevi-badge{position:fixed;z-index:2147483647;pointer-events:none;
  font:600 11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;
  padding:1px 5px;border-radius:3px;background:var(--jsbarevi-ui-bg,#111);
  color:var(--jsbarevi-ui-accent,#a6e22e);opacity:.92;
  box-shadow:0 0 0 1px var(--jsbarevi-ui-ring,transparent),
    0 2px 8px var(--jsbarevi-ui-shadow,transparent)}
.jsbarevi-line{position:fixed;z-index:2147483647;font:500 12px/1.5 ui-monospace,monospace;
  background:var(--jsbarevi-ui-bg,#111);color:var(--jsbarevi-ui-fg,#ddd);
  padding:2px 8px;border-radius:3px;max-width:60vw;
  box-shadow:0 0 0 1px var(--jsbarevi-ui-ring,transparent),
    0 2px 8px var(--jsbarevi-ui-shadow,transparent);
  white-space:pre;overflow:hidden;text-overflow:ellipsis;display:none}
.jsbarevi-line.error{color:var(--jsbarevi-ui-error,#ff6188)}
.jsbarevi-prompt{position:fixed;z-index:2147483647;font:500 12px/1.5 ui-monospace,monospace;
  background:var(--jsbarevi-ui-bg,#111);color:var(--jsbarevi-ui-prompt,#fd971f);
  box-shadow:0 0 0 1px var(--jsbarevi-ui-ring,transparent),
    0 2px 8px var(--jsbarevi-ui-shadow,transparent);
  border:0;outline:0;padding:2px 8px;border-radius:3px}
`;

let overlaySheet = null;

/**
 * The page's one clipboard cache. One per document, not one per field: the clipboard is
 * a property of the page, and two caches would disagree about what a copy in another
 * window looks like. The failure sink is per attachment (only the focused field's status
 * line is on screen), so `attach()` re-points it each time.
 */
let pageClipboard = null;
function clipboardFor() {
  if (!pageClipboard) pageClipboard = systemClipboard();
  return pageClipboard;
}

/**
 * Install the overlay CSS.
 *
 * A constructable stylesheet first, deliberately: a host with a strict
 * `style-src` (Lark, VS Code webviews, Electron apps serving from a custom
 * scheme) refuses an inline <style> element, and the badge would then render as
 * unstyled text over the page. CSSOM insertion is not subject to style-src, so
 * this is the one form that works everywhere; the <style> path stays as a
 * fallback for browsers without constructable sheets.
 */
function ensureStyles() {
  if (overlaySheet) return;
  try {
    if (document.adoptedStyleSheets && typeof CSSStyleSheet === "function") {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(OVERLAY_CSS);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      overlaySheet = sheet;
      return;
    }
  } catch { /* fall through to the element */ }
  if (document.getElementById("jsbarevi-style")) { overlaySheet = document.getElementById("jsbarevi-style").sheet; return; }
  const style = document.createElement("style");
  style.id = "jsbarevi-style";
  style.textContent = OVERLAY_CSS;
  document.documentElement.appendChild(style);
  overlaySheet = style.sheet;
}

function makeUi(el) {
  ensureStyles();
  const badge = document.createElement("div");
  badge.className = "jsbarevi-badge";
  const line = document.createElement("div");
  line.className = "jsbarevi-line";
  const prompt = document.createElement("input");
  prompt.className = "jsbarevi-prompt";
  prompt.style.display = "none";
  // The extension attaches to <input> elements on focus; without this marker the
  // engine would attach to its own command line and type into two buffers.
  for (const node of [badge, line, prompt]) node.setAttribute("data-jsbarevi-ui", "");
  document.body.append(badge, line, prompt);
  // The palette follows the page behind the FIELD, not the OS (adapters/theme.js): the
  // same chip on a white document needs dark text and a ring to read at all.
  const releaseTheme = [badge, line, prompt].map((node) => bindTheme(el, node));

  const place = () => {
    const r = el.getBoundingClientRect();
    badge.style.left = `${Math.max(4, r.left + 4)}px`;
    badge.style.top = `${Math.max(4, r.top - 18)}px`;
    line.style.left = `${Math.max(4, r.left + 4)}px`;
    line.style.top = `${Math.max(4, r.bottom + 4)}px`;
    prompt.style.left = `${Math.max(4, r.left + 4)}px`;
    prompt.style.top = `${Math.max(4, r.bottom + 4)}px`;
  };

  let statusTimer = 0;
  return {
    place,
    releaseTheme,
    setMode(mode, count) {
      place();
      // INSERT is the host's own state — a browser field is "inserting" by default, so a
      // badge for it says nothing the user did not already know. The states WE add are the
      // ones worth naming: NORMAL, VISUAL, REPLACE. (Edward, 2026-11-24: "if we really want
      // to hide something, hide INSERT".)
      const label = mode === "NORMAL" ? "-- NORMAL --" : mode === "REPLACE" ? "-- REPLACE --"
        : mode === "VISUAL" ? "-- VISUAL --" : mode === "VISUAL_LINE" ? "-- VISUAL LINE --" : "";
      // …and never on a field that does not hold the focus: a blurred editor is not in a
      // mode at all, and a badge there is a claim about a field the user is not typing in.
      const focused = el === document.activeElement || el.contains(document.activeElement);
      badge.textContent = label;
      badge.style.display = label && focused ? "block" : "none";
      if (count) badge.textContent = `${label} ${count}`;
    },
    status(msg, kind) {
      place();
      clearTimeout(statusTimer);
      if (!msg) { line.style.display = "none"; return; }
      line.textContent = msg;
      line.className = "jsbarevi-line" + (kind === "error" ? " error" : "");
      line.style.display = "block";
      statusTimer = setTimeout(() => { line.style.display = "none"; }, 4000);
    },
    prompt(kind, initial) {
      place();
      prompt.style.display = "block";
      // The sigil lives in the input, as it does in vi: ":" for ex, "/" or "?"
      // for search. That is what makes "delete the sigil to leave" expressible.
      prompt.value = initial || (kind === "ex" ? ":" : "/");
      prompt.dataset.sigil = prompt.value[0];
      prompt.focus();
      prompt.setSelectionRange(prompt.value.length, prompt.value.length);
      return prompt;
    },
    hidePrompt() { prompt.style.display = "none"; el.focus(); },
    promptEl: prompt,
    // destroy() must leave the page as it found it: the badge and the status line are
    // ours, and a page that toggles the extension off should not keep them.
    nodes: [badge, line, prompt],
  };
}

/** Attach to one field. Returns a handle with destroy(). */
// The semver comes from package.json at build time (via build-info.js), never from a
// literal here: a hard-coded prefix printed `0.1.0+<commit>` on every release up to
// 0.6.0, so a current build labelled itself as a stale one — the exact confusion this
// string exists to remove.
import { BUILD as STAMP, VERSION } from "./build-info.js";
export const BUILD = `${VERSION}+${STAMP}`;

// ONE adapter per field. A host that re-renders (Keep) can hand us the same node twice,
// and two engines on one document is the failure this project already paid for once: the
// first eats keys, the second paints the badge — and either can project a stale range.
const ATTACHED = new WeakMap();

export function attach(el, opts = {}) {
  const previous = ATTACHED.get(el);
  if (previous) {
    try { previous.destroy(); } catch { /* already gone */ }
  }
  const ui = makeUi(el);
  // A stale page is invisible otherwise: say which build is running.
  if (typeof console !== "undefined") {
    const what = el.hasAttribute("contenteditable") ? "contenteditable" : el.tagName.toLowerCase();
    console.info(`[jsbarevi] ${BUILD} attached to`, what);
  }
  const Adapter = adapterFor(el);
  const clipboard = opts.clipboard || clipboardFor();
  // Only the focused field's status line is visible, so the last attach owns the sink.
  clipboard.onStatus = (msg, kind) => ui.status(msg, kind);
  const adapter = new Adapter(el, {
    ...opts,
    clipboard,
    // the full stamp, not just the semver: ":version" is the in-field way to tell
    // one commit from another, which is what a stale page looks like from inside
    version: BUILD,
    onStatus: (msg, kind) => ui.status(msg, kind),
    onModeChange: (mode, count) => {
      // The MAIN-world Escape blocker reads this: while the marker is present, a
      // site's programmatic blur() is ignored, so Escape cannot eject the user from
      // the field. One marker, set in one place, for both adapters.
      el.setAttribute("data-jsbarevi-mode", mode || "NORMAL");
      ui.setMode(mode, count);
    },
    onPrompt: (kind, initial) => {
      const input = ui.prompt(kind, initial);
      input.dataset.kind = kind;
    },
    // The adapter's release path (`:q`, or a host that flipped contenteditable off) must
    // take the UI with it. A host that manages release itself — the extension's content
    // script, which keeps its own field registry — keeps its handler; anywhere else we
    // destroy the handle.
    ...(opts.onQuit ? {} : { onQuit: () => handle.destroy() }),
  });

  const promptOpen = () => ui.promptEl.style.display !== "none";
  const cancelPrompt = () => { ui.hidePrompt(); adapter.cancelPrompt(); };

  const onPromptKey = (e) => {
    if (!promptOpen()) return;
    const kind = ui.promptEl.dataset.kind;
    if (e.key === "Enter") {
      e.preventDefault();
      const value = ui.promptEl.value.replace(/^[:/?]/, "");
      ui.hidePrompt();
      adapter.finishPrompt(kind, value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelPrompt();
    } else if (e.ctrlKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      cancelPrompt();
    }
    e.stopPropagation();
  };

  // Measured against vim, nvi and busybox vi: deleting the typed text but leaving
  // the sigil keeps you in the command line — only deleting the ":" itself (or the
  // "/") leaves it. So the test is "is the sigil still there", not "is anything
  // left after it".
  const onPromptInput = () => {
    if (!promptOpen()) return;
    const sigil = ui.promptEl.dataset.sigil || ":";
    if (ui.promptEl.value[0] !== sigil) cancelPrompt();
  };
  ui.promptEl.addEventListener("keydown", onPromptKey, true);
  ui.promptEl.addEventListener("input", onPromptInput);

  const onResize = () => ui.place();
  window.addEventListener("resize", onResize);
  window.addEventListener("scroll", onResize, true);
  // The clipboard cannot be read synchronously, so the cache is refreshed when a field
  // takes focus — which is always before the `"+p` that needs it.
  const onFocus = () => clipboard.refresh?.();
  el.addEventListener("focus", onFocus);

  const handle = {
    adapter,
    engine: adapter.engine,
    /**
     * The fallback path for an Escape whose keydown was swallowed: the command line
     * takes priority, then the engine (see the adapters' handleEscape).
     */
    escape() {
      if (ui.promptEl.style.display !== "none") { cancelPrompt(); return true; }
      return adapter.handleEscape ? adapter.handleEscape() : false;
    },
    // The extension claims a field on focus; a key can arrive first (an SPA that
    // re-renders its composer and focuses the new node, a field that existed before
    // the content script). Hand that key to the adapter directly — a listener added
    // during dispatch never sees the event that is already in flight.
    keydown: (e) => adapter._onKeydown(e),
    destroy() {
      ATTACHED.delete(el);
      adapter.destroy();
      ui.promptEl.removeEventListener("keydown", onPromptKey, true);
      ui.promptEl.removeEventListener("input", onPromptInput);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
      el.removeEventListener("focus", onFocus);
      for (const release of ui.releaseTheme) { try { release(); } catch { /* already gone */ } }
      el.removeAttribute("data-jsbarevi-mode");
      for (const node of ui.nodes) node.remove();
    },
  };
  ATTACHED.set(el, handle);
  return handle;
}

export { Engine } from "./engine/engine.js";
export { TextareaAdapter } from "./adapters/textarea.js";
export { ContenteditableAdapter } from "./adapters/contenteditable.js";
