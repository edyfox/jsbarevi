// Key tokenisation, shared by every adapter.
//
// The rule is the same in a textarea and in a rich composer, because it is a rule
// about VI, not about the host: which browser keypress is which vi token, and who
// owns caret-moving keys. It lived inside TextareaAdapter, which meant the second
// adapter would have re-derived it — and the first divergence would be a key that
// works in one host only.

import { Mode } from "../engine/engine.js";

/**
 * The vi token for a keyboard event, or null when the host keeps the key.
 *
 * Ctrl combos are vi's; Cmd/Alt are the operating system's. Arrows and Home/End are
 * mapped to the SCREEN-LINE motions (gk gj g0 g$), which is what the browser does
 * with a caret in insert mode and what vim does when 'wrap' is set; 0 $ j k stay
 * the buffer-line motions they are in vim.
 */
export function tokenFor(e, mode) {
  if (e.ctrlKey && !e.altKey && !e.metaKey) {
    const k = e.key.toLowerCase();
    if (k === "c") return "C-c";
    // `a`/`x` are here because they are vi's increment/decrement: leaving them to the
    // browser means Ctrl-A selects the whole page and Ctrl-X CUTS the field.
    // `w`/`u` are here for the same reason one step further in: in INSERT mode they are
    // vi's delete-word / delete-to-insert-start, and the browser's own answers to them
    // are close-tab (Chrome reserves it, so a page cannot win) and view-source. In
    // normal mode `u` is still undo and `w` (vim's window prefix) is not implemented, so
    // it falls through to the host — the engine decides, not this table.
    if (["a", "x", "r", "w", "u", "d", "f", "b", "e", "y", "g"].includes(k)) return `C-${k}`;
    return null;
  }
  if (e.altKey || e.metaKey) return null;
  const caret = {
    ArrowLeft: "h", ArrowRight: "l", ArrowUp: "gk", ArrowDown: "gj",
    Home: "g0", End: "g$", PageUp: "C-b", PageDown: "C-f",
  };
  if (caret[e.key] !== undefined) {
    // In insert mode the browser owns the caret, and Shift+arrow is a selection.
    if (mode === Mode.INSERT || e.shiftKey) return null;
    return caret[e.key];
  }
  const named = { Escape: "Esc", Enter: "CR", Backspace: "BS", Tab: "Tab" };
  if (named[e.key] !== undefined) return named[e.key];
  if (e.key.length === 1) return e.key;
  return null;
}
