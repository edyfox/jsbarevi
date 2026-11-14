// Cursor primitives, ported from busybox's vi.c.
//
// The point is not the arithmetic, it is that the boundary rules live INSIDE the
// primitive, so no caller can get them wrong. Our three line-boundary bugs all
// came from hand-rolling `nextChar()`/`prevChar()` at call sites:
//   1. leaving insert at column 1 walked onto the previous line
//   2. `a` on an empty line stepped past the newline
//   3. counts on empty inserts
//
// busybox's versions (editors/vi.c:1811-1867):
//   static void dot_left(void)  { if (dot > text && dot[-1] != '\n') dot--; }
//   static void dot_right(void) { if (dot < end - 1 && *dot != '\n') dot++; }
//   static void dot_begin(void) { dot = begin_line(dot); }
//   static void dot_end(void)   { dot = end_line(dot); }      // last char of line
//   static void dot_next(void)  { dot = next_line(dot); }
//   static void dot_prev(void)  { dot = prev_line(dot); }
//
// Note the asymmetry, which is deliberate and is why busybox also normalises at
// the end of every command: `right` MAY land on a newline (`l` at EOL then gets
// pulled back by that normalisation), but `left` never steps back across one.
// So `right` is paired with Engine._stayOffNewline(); `left` needs no help.

import * as B from "./buffer.js";

/** One character left, never across a line boundary. */
export function left(text, i) {
  if (i > 0 && text[i - 1] !== "\n") return B.prevChar(text, i);
  return i;
}

/** One character right; never past the last character (may park on a newline). */
export function right(text, i) {
  if (i < text.length - 1 && text[i] !== "\n") return B.nextChar(text, i);
  return i;
}

export function beginLine(text, i) {
  return B.lineStart(text, i);
}

/** Last character of the cursor's line (busybox `dot_end`). */
export function endLine(text, i) {
  return B.lastCharOffset(text, i);
}

export function nextLine(text, i) {
  const n = B.lineNumber(text, i);
  return n >= B.lineCount(text) - 1 ? i : B.lineOffset(text, n + 1);
}

export function prevLine(text, i) {
  const n = B.lineNumber(text, i);
  return n <= 0 ? i : B.lineOffset(text, n - 1);
}

/** First non-blank of the line; never crosses into the next line. */
export function skipBlank(text, i) {
  return B.firstNonBlank(text, i);
}
