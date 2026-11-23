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
  // The classic clipboard set — Shift+Delete / Ctrl+Insert / Shift+Insert — for the hosts
  // and hands that use it instead of Ctrl-X/C/V. Everywhere but VISUAL LINE they belong to
  // the host; `V` has no native selection to act on, so there they are translated to the
  // keys the engine simulates, and mean exactly the same thing.
  if (mode === Mode.VISUAL_LINE) {
    if (e.key === "Insert" && e.shiftKey && !e.ctrlKey) return "C-v";
    if (e.key === "Insert" && e.ctrlKey && !e.shiftKey) return "C-c";
    if (e.key === "Delete" && e.shiftKey) return "C-x";
  }
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
    // `v`/`q` are here for the same reason as `a`/`x`: the engine must see them so it can
    // REFUSE block visual (and its `C-q` alias) with a message instead of letting the
    // browser paste the clipboard into the field behind the engine's back.
    if (["a", "x", "r", "w", "u", "d", "f", "b", "e", "y", "g", "v", "q"].includes(k)) return `C-${k}`;
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
  // The Insert key toggles insert ⇄ replace (`normal --Insert--> insert --Insert--> replace
  // --Insert--> insert`). It is handled HERE rather than in the named table below because
  // the modifier decides everything: **Shift+Insert is the old paste shortcut** and
  // Ctrl+Insert the old copy one, and swallowing either would take a key the host owns —
  // Shift+Insert silently toggled replace mode instead of pasting, which is exactly the
  // report that produced this line.
  if (e.key === "Insert" && !e.shiftKey) return "Insert";
  const named = { Escape: "Esc", Enter: "CR", Backspace: "BS", Tab: "Tab" };
  if (named[e.key] !== undefined) return named[e.key];
  if (e.key.length === 1) return e.key;
  return null;
}

/**
 * The engine motion for a Shift-modified caret key in VISUAL LINE, or null.
 *
 * Shift+caret belongs to the HOST in every mode (docs/DECISIONS.md), and in CHARWISE
 * visual that is exactly right: the browser extends the range we project there. VISUAL
 * LINE has no native selection to extend (a native one cannot draw the full-width bar),
 * so the same gesture would start a fresh native selection from the collapsed caret and
 * quietly turn V into v. These are the engine motions that keep it linewise, and they are
 * vim's own rule (`<S-Down>` extends a visual selection by a line).
 */
const SHIFT_MOTION = {
  ArrowLeft: "h", ArrowRight: "l", ArrowUp: "k", ArrowDown: "j",
  Home: "g0", End: "g$", PageUp: "C-b", PageDown: "C-f",
};

export function shiftMotionFor(e, mode) {
  if (!e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return null;
  if (mode !== Mode.VISUAL_LINE) return null;
  return SHIFT_MOTION[e.key] ?? null;
}
