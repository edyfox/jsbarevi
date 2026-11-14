// The system clipboard, as far as a SYNCHRONOUS engine can touch it.
//
// Vim reads `"+` and gets a string back. A browser's async clipboard cannot answer a
// synchronous engine, so this module provides three sources, in order of preference:
//
//   * **`document.execCommand("paste")`** — synchronous, and allowed in a content script
//     that holds the extension's `clipboardRead` permission. It is the only path with no
//     per-page prompt, so it is tried first (see `execCommandPaste` for the cost: it
//     borrows the focus for one synchronous call and gives it straight back).
//   * a `paste` event — the browser hands us the text, and it always works, including in
//     a page world where no extension permission exists (Lark, Electron's oc:// pages);
//   * our own writes — after `"+y` the cache holds exactly what we put there;
//   * `navigator.clipboard.readText()` on focus — attempted, never waited on.
//
// `navigator.clipboard.readText()` from a CONTENT SCRIPT is gated by the PAGE's
// permission, not the extension's: that is a prompt per site, which is why it is the
// last resort rather than the mechanism. Where every source is unavailable the status
// line says "system clipboard unavailable" instead of pretending the clipboard is empty.
//
// `*` is an alias of `+` at the register layer (registers.js); there is one clipboard
// here, so there is one implementation.

const HIDDEN = "position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none";

export function systemClipboard(doc = document) {
  const state = { text: "", known: false };
  /** Where a failure goes: the focused field's status line, wired by entry.js. */
  const sink = { report: () => {} };

  const remember = (value) => {
    if (typeof value === "string") { state.text = value; state.known = true; }
  };

  // The one source that never fails. Capture phase, so a host that stops propagation on
  // its own composer cannot hide the text from us.
  doc.addEventListener("paste", (e) => {
    try { remember(e.clipboardData?.getData("text/plain")); } catch { /* no data */ }
  }, true);

  return {
    /** @param {(msg: string, kind?: string) => void} fn */
    set onStatus(fn) { sink.report = typeof fn === "function" ? fn : () => {}; },

    read() {
      const pasted = execCommandPaste();
      if (pasted != null) { remember(pasted); return pasted; }
      return state.known ? state.text : null;
    },

    write(text) {
      remember(text);
      const nav = globalThis.navigator?.clipboard;
      if (nav?.writeText) {
        nav.writeText(text).catch((err) => {
          // A page can refuse the async API and still allow the old synchronous one
          // inside a real keypress — which is exactly the situation we are in.
          if (!execCommandCopy(text)) sink.report(`clipboard write refused: ${err.message}`, "error");
        });
        return;
      }
      if (!execCommandCopy(text)) sink.report("no system clipboard in this host", "error");
    },

    /** Learn the clipboard without blocking anything. Called on focus. */
    refresh() {
      const nav = globalThis.navigator?.clipboard;
      if (!nav?.readText) return;
      nav.readText().then(remember, () => { /* refused or not yet permitted */ });
    },
  };
}

/**
 * `document.execCommand("paste")` into a hidden field — the one SYNCHRONOUS read.
 *
 * Allowed in a content script that declares the `clipboardRead` permission; refused
 * (returns null) everywhere else, which is what makes it safe to try first: the page
 * world of Lark or an Electron `oc://` window simply falls through to the cache.
 *
 * The cost is real and is why this is not used for background refreshes: execCommand
 * pastes into the *focused* element, so a hidden one has to take the focus for the
 * duration of a synchronous call, and the focus and selection are put back immediately
 * afterwards. That is acceptable when the user pressed `"+p` — they asked for the
 * clipboard — and unacceptable on every focus or keystroke.
 */
function execCommandPaste() {
  const doc = document;
  const active = doc.activeElement;
  const sel = doc.getSelection ? doc.getSelection() : null;
  const ranges = [];
  if (sel) for (let i = 0; i < sel.rangeCount; i++) ranges.push(sel.getRangeAt(i).cloneRange());

  const ta = doc.createElement("textarea");
  ta.setAttribute("data-jsbarevi-ui", "");     // never let an engine attach to it
  ta.style.cssText = HIDDEN;
  doc.body.appendChild(ta);
  let value = null;
  try {
    ta.focus();
    ta.select();
    if (doc.execCommand("paste")) value = ta.value;
  } catch { value = null; }
  ta.remove();
  try {
    if (active && active.focus) active.focus({ preventScroll: true });
    if (sel) { sel.removeAllRanges(); for (const r of ranges) sel.addRange(r); }
  } catch { /* the page may have torn the node down */ }
  return value;
}

/**
 * The deprecated copy path.
 *
 * Kept because it is the only one that works when the clipboard API is missing or
 * refused, and it must leave the page exactly as it found it: a hidden textarea steals
 * the focus and the selection, and in a rich composer that is the host's model, not just
 * a caret. So both are saved first and restored after, and the textarea carries the UI
 * marker so no engine ever attaches to it.
 */
function execCommandCopy(text) {
  const doc = document;
  const active = doc.activeElement;
  const sel = doc.getSelection ? doc.getSelection() : null;
  const ranges = [];
  if (sel) for (let i = 0; i < sel.rangeCount; i++) ranges.push(sel.getRangeAt(i).cloneRange());

  const ta = doc.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.setAttribute("data-jsbarevi-ui", "");
  ta.style.cssText = HIDDEN;
  doc.body.appendChild(ta);
  let ok = false;
  try {
    ta.select();
    ok = doc.execCommand("copy");
  } catch { ok = false; }
  ta.remove();
  try {
    if (active && active.focus) active.focus({ preventScroll: true });
    if (sel) { sel.removeAllRanges(); for (const r of ranges) sel.addRange(r); }
  } catch { /* the page may have torn the node down */ }
  return ok;
}
