// The system clipboard, as far as a SYNCHRONOUS engine can touch it.
//
// Vim reads `"+` and gets a string back. A browser's clipboard is asynchronous and
// permission-gated, so a synchronous engine cannot call that API — it reads a CACHE,
// and this module is what keeps the cache fresh. Three sources, in order of reliability:
//
//   * a `paste` event — the browser hands us the text synchronously and it always works;
//   * our own writes — after `"+y` the cache holds exactly what we put there;
//   * `navigator.clipboard.readText()` on focus, which may be refused or may prompt.
//     It is attempted, never waited on: the engine's read is synchronous by design.
//
// The honest consequence: `"+p` can be empty right after you copy something in another
// window, because the page has not been told. One Ctrl+V in the page fills it, or one
// focus with the read permission granted. The status line then says "system clipboard
// unavailable" instead of pretending the clipboard is empty — a difference the user can
// act on.
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

    read() { return state.known ? state.text : null; },

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
