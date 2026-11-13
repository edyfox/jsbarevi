// Unit tests for what a keystroke-level differential cannot see: prompts, the
// `:` line, the regex contract, registers, marks and the viewport capability.

import { Engine, Mode } from "../src/engine/engine.js";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${ok ? "" : `\n       got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

function mk(text, cursor = 0, opts = {}) {
  const e = new Engine(opts);
  e.setText(text, cursor);
  return e;
}
function ex(e, line) { e.feed(":"); e.submitPrompt(line); return e; }

console.log("\n\x1b[1mprompts and search\x1b[0m");
{
  const e = mk("alpha beta gamma\n");
  e.feed("/"); const r = e.submitPrompt("beta");
  eq("search moves to the match", e.cursor, 6);
  eq("search reports a prompt", typeof r, "object");
}
{
  const e = mk("a1 b2\nc3 d4\n");
  e.feed("/"); e.submitPrompt("\\d");   // Vim's \d is the digit class, as in JS
  eq("\\d searches digits", e.text[e.cursor], "1");
}
{
  const e = mk("foo\nbar\nfoo\n");
  e.feed(":"); e.submitPrompt("s/foo/baz/");
  eq(":s replaces one occurrence on the line", e.text, "baz\nbar\nfoo\n");
}
{
  const e = mk("foo foo foo\n");
  ex(e, "%s/foo/x/g");
  eq(":%s with g replaces all", e.text, "x x x\n");
}
{
  const e = mk("abc 123\n");
  ex(e, "s/\\d\\+/N/");
  eq("\\+ is translated (not a literal plus)", e.text, "abc N\n");
}
{
  const e = mk("say hello there\n");
  ex(e, "s/hello/[&]/");
  eq("& expands to the whole match", e.text, "say [hello] there\n");
}
{
  const e = mk("word boundary\n");
  ex(e, "s/\\<boundary\\>/X/");
  eq("\\< \\> become word boundaries", e.text, "word X\n");
}
{
  const e = mk("a b\n");
  ex(e, "s/[[:space:]]/_/");
  eq("POSIX class is refused, not silently ignored", e.status.some((s) => /POSIX/.test(s)), true);
}
{
  const e = mk("a b\n");
  ex(e, "s/\\zs/x/");
  eq("\\zs is refused", e.status.some((s) => /match start/.test(s)), true);
}
{
  const e = mk("Foo\nfoo\n");
  ex(e, "set ic");
  ex(e, "%s/foo/X/g");
  eq(":set ic affects :s", e.text, "X\nX\n");
}
{
  const e = mk("a\nb\nc\n");
  ex(e, "2d");
  eq(":2d deletes the second line", e.text, "a\nc\n");
}
{
  const e = mk("a\nb\nc\n");
  ex(e, "set ts=2");
  eq(":set ts=2 sticks", e.options.tabstop, 2);
}

console.log("\n\x1b[1mregisters and marks\x1b[0m");
{
  const e = mk("one\ntwo\n");
  e.feedKeys('"ayyj"ap');
  eq('"a yank then "a put', e.text, "one\ntwo\none\n");
}
{
  const e = mk("aaa\nbbb\n");
  e.feed("m"); e.feed("a"); e.feedKeys("G");
  e.feed("'"); e.feed("a");
  eq("mark and jump to its line", e.cursor, 0);
}

console.log("\n\x1b[1mviewport capability\x1b[0m");
{
  const e = mk("l1\nl2\nl3\nl4\nl5\nl6\n", 0, { viewport: () => ({ top: 0, height: 4 }) });
  e.feedKeys("H");
  eq("H goes to the first visible line", e.cursor, 0);
  e.feedKeys("L");
  eq("L goes to the last visible line", e.text.slice(0, e.cursor).split("\n").length, 4);
}
{
  const e = mk("a\nb\nc\nd\ne\nf\ng\nh\n");
  e.feed("C-d");
  eq("C-d without a viewport still moves (documented fallback)", e.text.slice(0, e.cursor).split("\n").length > 1, true);
}

console.log("\n\x1b[1mcounts and pending state\x1b[0m");
{
  const e = mk("a b c d e\n");
  e.feedKeys("2dw");
  eq("count before an operator applies to the motion", e.text, "c d e\n");
}
{
  const e = mk("abc\ndef\n");
  e.feedKeys("d"); e.feed("Esc");
  eq("Esc cancels a pending operator", e.text, "abc\ndef\n");
}
{
  const e = mk("abcdef\n");
  e.feedKeys("d2l");
  eq("operator with a count deletes that many chars", e.text, "cdef\n");
}

// Shift+click extends a visual selection by moving the ANCHOR to the far side
// (vim mouse.c:903-963, reached because a shifted left click is rewritten into a
// right click at mouse.c:753). The rules were measured from that code: outside
// the selection the far end stays, inside it the nearer side moves.
console.log("\n\x1b[1mshift+click adjusts the selection: grows outside, shrinks inside\x1b[0m");
const textOf = (e) => e.visualText();
{
  // "one two three\n": select "two" (4..7), then click far left of it.
  const e = mk("one two three\n");
  e.enterVisualFromHost(4, 6);
  e.extendVisualToClick(0, 4, 6);
  // clicked left of the selection -> the far end (6) stays as the anchor, so the
  // selection runs from the click to it: "one two" (0..6 inclusive)
  eq("clicking before the selection keeps its end and grows left", textOf(e), "one two");
}
{
  const e = mk("one two three\n");
  e.enterVisualFromHost(4, 6);
  e.extendVisualToClick(12, 4, 6);   // on the last character
  eq("clicking after the selection keeps its start and grows right", textOf(e), "two three");
}
{
  // Inside the selection one boundary moves to the click, so it SHRINKS - the
  // far half is kept and the part the click is on is dropped. Not a "grow".
  const e = mk("abcdefghij\n");
  e.enterVisualFromHost(0, 7);       // selection "abcdefgh" (8 characters)
  const before = textOf(e).length;
  e.extendVisualToClick(6, 0, 7);    // near the end -> the end moves in
  eq("clicking inside near the end shrinks it", textOf(e), "abcdefg");
  eq("...so the selection got shorter, not longer", textOf(e).length < before, true);
}
{
  const e = mk("abcdefghij\n");
  e.enterVisualFromHost(0, 7);
  e.extendVisualToClick(2, 0, 7);    // near the start -> the start moves in
  eq("clicking inside near the start shrinks the other way", textOf(e), "cdefgh");
}
{
  // A click exactly in the middle is a tie, and vim's test is a strict ">"
  // (mouse.c:947), so the tie keeps the far end as the anchor.
  const e = mk("abcdefghij\n");
  e.enterVisualFromHost(0, 8);       // "abcdefghi" (9 characters, midpoint 4)
  e.extendVisualToClick(4, 0, 8);
  eq("a click exactly in the middle keeps the end side", textOf(e), "efghi");
}
{
  // Across lines vim compares line distance first, columns only on a tie.
  const e = mk("aa\nbb\ncc\ndd\n");
  e.enterVisualFromHost(0, 9);       // lines 1..4
  e.extendVisualToClick(4, 0, 9);    // line 2: nearer the start, so line 4 stays
  eq("a cross-line click nearer the start keeps the end", textOf(e), "b\ncc\nd");
}
{
  const e = mk("aa\nbb\ncc\ndd\n");
  e.enterVisualFromHost(0, 9);
  e.extendVisualToClick(7, 0, 9);    // line 3: nearer the end
  eq("a cross-line click nearer the end keeps the start", textOf(e), "aa\nbb\ncc");
}
{
  // A linewise selection stays linewise, and the click itself is clamped onto a
  // character (a DOM caret may sit past the last character of a line).
  const e = mk("aa\nbb\ncc\n");
  e.feedKeys("Vj");                  // lines 1-2, linewise
  e.extendVisualToClick(e.text.length - 1, 0, 3);
  eq("shift+click does not leave visual line mode", e.mode, "VISUAL_LINE");
  eq("...and keeps whole lines on the side it kept", textOf(e), "aa\nbb\ncc\n");
}

console.log("\n\x1b[1mundo granularity: one block per change command\x1b[0m");
{
  // the reported bug: `s` deleted, Esc ended the insert, and the first `u` only
  // stepped the cursor right because the deletion and the insert were recorded
  // separately. Now the insert belongs to the command that opened it.
  const e = mk("abc\ndef\n");
  e.feedKeys("s<Esc>");
  eq("s + Esc records exactly one undo step", e.undoStack.length, 1);
  e.feed("u");
  eq("one u puts the deleted character back", e.hostText, "abc\ndef");
  eq("...and leaves the cursor where the change began", e.cursor, 0);
  eq("...with the step consumed", e.undoStack.length, 0);
}
{
  const e = mk("abc\ndef\n");
  e.feedKeys("i<Esc>");
  eq("an insert that typed nothing is not an undo step", e.undoStack.length, 0);
}
{
  const e = mk("abc\ndef\n");
  e.feedKeys("xu");
  eq("x then u", e.hostText, "abc\ndef");
}
{
  const e = mk("abc\ndef\n");
  e.feedKeys("ddu");
  eq("dd then u", e.hostText, "abc\ndef");
}
{
  // a change command's two halves must not leave a step behind: after `u` the
  // stack has to be empty, or a second u would undo something older.
  const e = mk("abc\ndef\n");
  e.feedKeys("cc<Esc>");
  eq("cc + Esc is one step", e.undoStack.length, 1);
  e.feed("u");
  eq("...and one u restores the line", e.hostText, "abc\ndef");
}
{
  // `:d` mutates outside feed(); it must close its own block or it would swallow
  // the next command's undo step.
  const e = mk("a\nb\nc\n");
  ex(e, "2d");
  e.feedKeys("x");
  eq("an ex delete and a following x are two steps", e.undoStack.length, 2);
  e.feed("u");
  eq("u undoes only the x", e.hostText, "a\nc");
  e.feed("u");
  eq("...and the next u undoes the :d", e.hostText, "a\nb\nc");
}

// Screen lines vs buffer lines: `j k 0 $` are buffer-line motions, `gj gk g0 g$`
// are screen-line motions (vim: gj/gk are display lines; <Up>/<Down> are too when
// 'wrap' is set). The engine gets the wrap from a `metrics` capability, so the
// logic is testable here with a synthetic one - no browser needed.
console.log("\n\x1b[1mscreen lines: gj gk g0 g$\x1b[0m");
const wrapMetrics = (text, perRow, charW = 10, lineH = 20) => {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return (offset) => {
    const at = Math.max(0, Math.min(offset, text.length - 1));
    let line = 0;
    for (let n = 0; n < starts.length; n++) if (starts[n] <= at) line = n;
    const col = at - starts[line];
    return { x: (col % perRow) * charW, y: (line + Math.floor(col / perRow)) * lineH, width: charW, height: lineH };
  };
};
{
  // 10 characters, 4 per screen row: rows are 0-3, 4-7, 8-9.
  const text = "abcdefghij\n";
  const e = mk(text, 5, { metrics: wrapMetrics(text, 4) });
  e.feedKeys("g0");
  eq("g0 goes to the start of the SCREEN row, not the line", e.cursor, 4);
  e.feedKeys("g$");
  eq("g$ goes to the last character of the SCREEN row", e.cursor, 7);
  eq("...which is not the end of the buffer line", e.cursor !== 9, true);
  e.feedKeys("0");
  eq("0 is still the buffer-line start", e.cursor, 0);
  e.feedKeys("$");
  eq("$ is still the buffer-line end", e.cursor, 9);
}
{
  const text = "abcdefghij\n";
  const e = mk(text, 1, { metrics: wrapMetrics(text, 4) });
  e.feedKeys("gj");
  eq("gj moves one SCREEN row, keeping the screen column", e.cursor, 5);
  e.feedKeys("gj");
  eq("gj again", e.cursor, 9);
  e.feedKeys("gk");
  eq("gk moves back up", e.cursor, 5);
  e.feedKeys("j");
  eq("j is still a buffer-line motion (there is no line 2)", e.cursor, 5);
}
{
  const text = "abcdefghij\nklmnop\n";
  const e = mk(text, 9, { metrics: wrapMetrics(text, 4) });
  e.feedKeys("gj");
  // screen column 2 of the row (offset 9 is the row's 2nd character), so the
  // destination is the 2nd character of the next row
  eq("gj crosses a hard line break into the next line's first row", e.cursor, 12);
  e.feedKeys("gk");
  eq("gk comes back", e.cursor, 9);
  e.feedKeys("3gj");
  eq("gj with a count stops at the last row instead of beeping", e.cursor, 16);
}
{
  // The screen column is a WISH: a short row clamps it, the next row must not lose it.
  const text = "abcdefgh\nab\ncd\n";
  const e = mk(text, 2, { metrics: wrapMetrics(text, 8) });   // row 0 holds 0-7
  e.feedKeys("gj");
  eq("gj to a shorter row clamps to its end", e.cursor, 10);
  eq("...and the wish is remembered for the next gj", e.desiredX, 20);
}
{
  // Without a metrics capability the g-motions degrade to the buffer-line ones,
  // which is exactly right on a host that cannot wrap.
  const e = mk("abcdef\n");
  e.feedKeys("llg$");
  eq("g$ without measurement is $", e.cursor, 5);
  e.feedKeys("0g0");
  eq("g0 without measurement is 0", e.cursor, 0);
  const v = mk("ab\ncd\n");
  v.feedKeys("gj");
  eq("gj without measurement is j", v.cursor, 3);
}
{
  // visual mode extends on the screen-line motions too
  const text = "abcdefghij\n";
  const e = mk(text, 1, { metrics: wrapMetrics(text, 4) });
  e.feedKeys("vgj");
  eq("v then gj extends the selection by a screen row", e.visualText(), "bcdef");
}

// The viewport family speaks SCREEN ROWS: viewport() reports clientHeight/lineHeight
// rows, and feeding a row to lineOffset() is wrong the moment a line wraps. These
// all run through the same measurement the g-motions use.
console.log("\n\x1b[1mviewport commands in screen rows\x1b[0m");
{
  // 16 characters, 4 per row: rows are 0-3, 4-7, 8-11, 12-15. A 4-row window
  // starting at the top means H/L/M must land on rows 0 / 3 / 2.
  const text = "abcdefghijklmnop\n";
  const m = wrapMetrics(text, 4);
  const vp = { top: 0, height: 4 };
  const mk = () => new Engine({ metrics: m, viewport: () => vp });
  const go = (keys) => { const e = mk(); e.setText(text, 0); e.feedKeys(keys); return e; };
  eq("H lands on the first row", go("H").cursor, 0);
  eq("M lands on the middle row", go("M").cursor, 8);
  eq("L lands on the last visible row", go("L").cursor, 12);
  eq("2L counts from the bottom", go("2L").cursor, 8);
  eq("H from row 0 of a scrolled window uses vp.top", (() => { vp.top = 1; const e = go("H"); vp.top = 0; return e.cursor; })(), 4);
  const scrolled = [];
  const e = new Engine({ metrics: m, viewport: () => vp, onScroll: (r) => scrolled.push(r) });
  e.setText(text, 0);
  e.feed("C-f");
  eq("C-f moves the cursor a page of rows down", e.cursor, 8);
  eq("...and scrolls the window by the same rows", scrolled.at(-1), 2);
  const h = new Engine({ metrics: m, viewport: () => vp, onScroll: (r) => scrolled.push(r) });
  h.setText(text, 0);
  h.feed("C-d");
  eq("C-d moves half a page of rows", h.cursor, 8);
  eq("...scrolling by the same amount", scrolled.at(-1), 2);
  const z = new Engine({ metrics: m, viewport: () => vp, onScroll: (r) => scrolled.push(r) });
  z.setText(text, 8);                       // row 2
  z.feedKeys("zt");
  eq("zt scrolls the cursor's ROW to the top", scrolled.at(-1), 2);
  z.feedKeys("zb");
  eq("zb scrolls its row to the bottom of the window", scrolled.at(-1), 0);
}
{
  // Without a measurement the old buffer-line behaviour is all a host can do.
  const vp = { top: 0, height: 3 };
  const e = new Engine({ viewport: () => vp });
  e.setText("a\nb\nc\nd\ne\n", 0);
  e.feedKeys("L");
  eq("L without measurement still counts buffer lines", e.text.slice(0, e.cursor).split("\n").length, 3);
}

// Replace mode: insert is the host's, so the engine reconstructs the text from a
// snapshot taken when R was pressed, and tracks what was typed by diffing. That is
// what makes Backspace put the overwritten character back.
console.log("\n\x1b[1mreplace mode: R\x1b[0m");
{
  // Simulate the host: it types at the caret and reports the new value.
  const hostType = (e, ch) => {
    const v = e.hostText;
    const c = Math.min(e.cursor, v.length);
    e.applyHostEdit(v.slice(0, c) + ch + v.slice(c), c + 1);
  };
  const hostBackspace = (e) => {
    const v = e.hostText;
    const c = Math.min(e.cursor, v.length);
    if (c === 0) return;
    e.applyHostEdit(v.slice(0, c - 1) + v.slice(c), c - 1);
  };
  const e = mk("abcdef\n");
  e.feed("R");
  eq("R enters insert mode", e.mode, "INSERT");
  eq("...with a replace session", !!e.replaceSession, true);
  hostType(e, "X");
  eq("typing overwrites the character under the cursor", e.hostText, "Xbcdef");
  hostType(e, "Y");
  eq("and the next one", e.hostText, "XYcdef");
  eq("the cursor follows the typed run", e.cursor, 2);
  hostBackspace(e);
  eq("Backspace restores the character it replaced", e.hostText, "Xbcdef");
  hostBackspace(e);
  eq("...and the one before that", e.hostText, "abcdef");
  hostType(e, "Z");
  eq("retyping after backing out still overwrites", e.hostText, "Zbcdef");
  e.feed("Esc");
  eq("Esc ends the session", e.replaceSession, null);
  eq("...and the whole replace is ONE undo step", e.undoStack.length, 1);
  e.feed("u");
  eq("one u puts the original line back", e.hostText, "abcdef");
}
{
  // past the end of the line R appends instead of eating the next line
  const e = mk("ab\ncd\n");
  e.feed("R");
  const type = (ch) => {
    const v = e.hostText;
    const c = e.cursor;
    e.applyHostEdit(v.slice(0, c) + ch + v.slice(c), c + 1);
  };
  type("Z");
  eq("the first character overwrites the one under the cursor", e.hostText, "Zb\ncd");
  type("W");
  eq("the second overwrites the next one", e.hostText, "ZW\ncd");
  type("V");
  eq("typing past the end of the line appends instead of eating the newline", e.hostText, "ZWV\ncd");
  e.feed("Esc");
}
{
  // a plain insert is untouched: the host's text is the truth
  const e = mk("abc\n");
  e.feed("i");
  e.applyHostEdit("Xabc", 1);
  eq("insert mode still just adopts the host's text", e.hostText, "Xabc");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
