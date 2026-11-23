// Unit tests for what a keystroke-level differential cannot see: prompts, the
// `:` line, the regex contract, registers, marks and the viewport capability.

import { Engine, Mode } from "../src/engine/engine.js";
import { THEMES, LIGHT_SWITCH, luminance, parseColor, themeFromColor } from "../src/adapters/theme.js";

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

// The shape of this block is the shape of the decision (docs/DECISIONS.md): the unnamed
// register, one-character names, `_`, and the clipboard. What is NOT here on purpose is
// the numbered family — "1-"9 and "-" — whose rotation/small-big rules were measured
// against vim and then rejected as scope (docs/ENGINE.md).
console.log("\n\x1b[1mregisters: what is stored, and where\x1b[0m");
{
  const e = mk("alpha beta\ngamma\n");
  e.feedKeys("dd");
  eq("a plain delete fills the unnamed register", e.registers.read().text, "alpha beta\n");
  e.feedKeys("p");
  eq("...and p pastes it", e.text, "gamma\nalpha beta\n");
}
{
  const e = mk("alpha beta\ngamma\n");
  e.feedKeys('"ayw');
  eq("a named yank stores by name", e.registers.read("a").text, "alpha ");
  eq("...and ALSO fills the unnamed register (measured: vim does)",
    e.registers.read().text, "alpha ");
}
{
  const e = mk("one\ntwo\n");
  e.feedKeys('"ayy');
  e.feedKeys('"_dd');
  eq("the black hole stores nothing", e.registers.read(), { text: "one\n", linewise: true });
  eq("...and its own name has nothing", e.registers.read("_"), null);
}
{
  const e = mk("abcdef\nghijkl\n");
  e.feedKeys('vj"ay');
  eq('a visual selection yanks into a named register', e.registers.read("a").text, "abcdef\ng");
}
{
  // `"+yy` and `"+yaw` look like the same command and were not: the text-object path
  // threw the register away (a second, unreachable copy of that rule was the live one).
  const e = mk("alpha beta gamma\n");
  e.feedKeys('"ayaw');
  eq('"ayaw stores the object in a', e.registers.read("a").text, "alpha ");
  e.feedKeys('"adiw');
  eq('"adiw is the same command with a different object', e.registers.read("a").text, "alpha");
  e.feedKeys('"ayip');
  eq("a linewise text object stays linewise", e.registers.read("a").linewise, true);
}
{
  let clip = "OLD";
  const e = mk("alpha beta\ngamma\n", 0, { clipboard: { read: () => clip, write: (t) => { clip = t; } } });
  e.feedKeys('"+yaw');
  eq('"+yaw reaches the system clipboard', clip, "alpha ");
  e.feedKeys('"+daw');
  eq('"+daw does too', clip, "alpha ");
}
{
  const e = mk("keep me\n");
  e.feedKeys('"1dd');
  eq("an unsupported register aborts the command, buffer intact", e.hostText, "keep me");
  eq("...and says why", /unsupported register: 1/.test(e.status.slice(-1)[0] || ""), true);
}
{
  // One register prefix, one command. This leaked for real: `"ap` used to poison every
  // later `p` with register a, because the prefix stayed in `pending`.
  const e = mk("aaa bbb\nccc ddd\n");
  e.feedKeys('"ayw'); e.feedKeys("j"); e.feedKeys('"byw'); e.feedKeys("k");
  e.feedKeys('"ap');          // pastes "aaa " from a
  e.feedKeys("p");            // must paste "ccc " (the unnamed), not "aaa " again
  eq("the prefix applies once, then the unnamed register is used",
    e.hostText, "aaaa ccc aa bbb\nccc ddd");
  eq("...which holds the last yank (b), not a", e.registers.read().text, "ccc ");
}

console.log("\n\x1b[1mthe = register is refused, not approximated\x1b[0m");
{
  // `=` needs eval, and a page world refuses eval under its own CSP (Lark, Electron's
  // oc://). A feature that works in one host and silently fails in the others is worse
  // than no feature, so the prefix is rejected outright.
  const e = mk("x\n");
  e.feed('"'); e.feed("=");
  eq("the = prefix is an unsupported register", /unsupported register: =/.test(e.status.slice(-1)[0] || ""), true);
  eq("...no prompt opens", e.prompt, null);
  eq("...and the next command is swallowed", (() => { e.feedKeys("dd"); return e.hostText; })(), "x");
}

console.log("\n\x1b[1minsert mode: <C-r>{register}\x1b[0m");
{
  const e = mk("alpha beta\ngamma\n");
  e.feedKeys('"ayw');
  e.feedKeys("i");
  eq("<C-r> is consumed (unconsumed, it reloads the page)", e.feed("C-r").handled, true);
  eq("...the next key picks the register", e.feed("a").insertText, "alpha ");
}
{
  const e = mk("alpha beta\n");
  e.feedKeys('"ayw');
  e.feed("i"); e.feed("C-r");
  eq('i<C-r>" inserts the unnamed register', e.feed('"').insertText, "alpha ");
}
{
  let clip = "from the OS\n";
  const e = mk("x\n", 0, { clipboard: { read: () => clip, write: () => {} } });
  e.feed("i"); e.feed("C-r");
  // A linewise register inserts its lines without the trailing newline: the newline in
  // the register says "this is whole line(s)", it is not a character to type.
  eq("<C-r>+ hands the clipboard text to the host", e.feed("+").insertText, "from the OS");
}
{
  const e = mk("x\n");
  e.feed("i"); e.feed("C-r"); e.feed("Esc");
  eq("Esc clears a pending <C-r>", e._insertRegPending, false);
  eq("...so the next key is an ordinary command", e.feed("a").insertText, undefined);
}
{
  const e = mk("x\n");
  e.feed("i"); e.feed("C-r");
  eq("an unsupported register inside <C-r> reports and inserts nothing",
    [e.feed("1").insertText, /unsupported register: 1/.test(e.status.slice(-1)[0] || "")], [undefined, true]);
}
{
  const e = mk("x\n");
  e.feed("i"); e.feed("C-r");
  eq("an empty register inserts nothing", e.feed("a").insertText, undefined);
}

console.log("\n\x1b[1mthe system clipboard is a host capability\x1b[0m");
{
  let clip = "";
  const e = mk("alpha beta\ngamma\n", 0, { clipboard: { read: () => clip, write: (t) => { clip = t; } } });
  e.feedKeys('"+yy');
  eq('"+yy writes the system clipboard', clip, "alpha beta\n");
  eq("...and the unnamed register", e.registers.read().text, "alpha beta\n");
  clip = "from another app\n";
  e.feedKeys('"+p');
  eq('"+p reads the clipboard and pastes it as a line', e.hostText, "alpha beta\nfrom another app\ngamma");
}
{
  // `*` is an alias of `+`: a browser has one clipboard, and inventing a second one we
  // cannot fill would be a lie (registers.js).
  let clip = "shared\n";
  const e = mk("x\n", 0, { clipboard: { read: () => clip, write: (t) => { clip = t; } } });
  e.feedKeys('"*p');
  eq('"*p reads the same clipboard', e.hostText, "x\nshared");
  e.feedKeys('"*yy');
  eq('"*yy writes the same clipboard', clip, "shared\n");
}
{
  // No capability at all: say so rather than silently doing nothing.
  const e = mk("x\n");
  e.feedKeys('"+p');
  eq('"+p with no clipboard reports it', /system clipboard unavailable/.test(e.status.slice(-1)[0] || ""), true);
  eq("...and does not move the buffer", e.hostText, "x");
}

console.log("\n\x1b[1muppercase registers append (all four cases, measured against vim)\x1b[0m");
{
  // One rule covers the four combinations; these four cases are the measurement that
  // proves it, so they stay as four expectations.
  const line = "alpha beta\ngamma\n";
  const yank = (keys) => { const e = mk(line); e.feedKeys(keys); return e; };
  eq("linewise + linewise joins on a new line",
    yank('"ayy"Ayy"ap').hostText, "alpha beta\nalpha beta\nalpha beta\ngamma");
  eq("linewise + charwise puts the new text on its own line",
    yank('"ayy"Ayw"ap').hostText, "alpha beta\nalpha beta\nalpha \ngamma");
  eq("charwise + linewise: linewise wins, existing text first",
    yank('"ayw"Ayy"ap').hostText, "alpha beta\nalpha \nalpha beta\ngamma");
  const e = mk("alpha beta\ngamma\n");
  e.feedKeys('"ayw"Ayw');
  eq("charwise + charwise concatenates", e.registers.read("a").text, "alpha alpha ");
  eq("...and the unnamed register follows the merged content", e.registers.read().text, "alpha alpha ");
}

console.log("\n\x1b[1mthe : commands record registers too\x1b[0m");
{
  const e = mk("one\ntwo\nthree\n");
  e.feed(":"); e.submitPrompt("d");
  eq(":d fills the register like any delete", e.registers.read().text, "one\n");
  eq("...so p pastes the line back", (() => { e.feed("p"); return e.hostText; })(), "two\none\nthree");
}
{
  const y = mk("one\ntwo\n");
  y.feed(":"); y.submitPrompt("y");
  eq(":y fills the unnamed register", y.registers.read().text, "one\n");
  eq("...and a named one when asked", (() => {
    const n = mk("one\ntwo\n"); n.feed(":"); n.submitPrompt("y b");
    return n.registers.read("b").text;
  })(), "one\n");
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
  // An edit we did not predict (a framework rewriting the value, an IME commit,
  // a paste) must NOT end replace mode: silently becoming insert mode is the one
  // failure the user cannot see.
  const e = mk("abcdef\n");
  e.feed("R");
  const type = (ch) => {
    const v = e.hostText;
    const c = e.cursor;
    e.applyHostEdit(v.slice(0, c) + ch + v.slice(c), c + 1);
  };
  type("X");
  eq("replace is running", e.hostText, "Xbcdef");
  e.applyHostEdit("ZZZdef", 3);                    // a foreign, in-place rewrite
  eq("a foreign edit is adopted", e.hostText, "ZZZdef");
  eq("...and replace mode SURVIVES it", !!e.replaceSession, true);
  type("Q");   // the foreign edit left the cursor at 3, so Q overwrites 'd'
  eq("...so the next character still overwrites", e.hostText, "ZZZQef");
  e.feed("Esc");
  eq("only Esc ends it", e.replaceSession, null);
}

{
  // a plain insert is untouched: the host's text is the truth
  const e = mk("abc\n");
  e.feed("i");
  e.applyHostEdit("Xabc", 1);
  eq("insert mode still just adopts the host's text", e.hostText, "Xabc");
}

{
  // :version carries the build, so a stale page is identifiable from inside the field
  const e = mk("abc\n", 0, { version: "0.1.0+abc1234" });
  e.feed(":");
  const r = e.submitPrompt("version");
  eq(":version reports the build, not just the semver", r.ex.message, "jsbarevi 0.1.0+abc1234");
}

{
  // A mouse click moves the caret outside any command. The vertical WISHES must not
  // outlive it, or gj/gk and j/k jump back to the pre-click column.
  const text = "abcdefghij\n";
  const e = mk(text, 0, { metrics: wrapMetrics(text, 4) });
  e.feed("g"); e.feed("j");                    // row 2, screen column 0 ... wish = x(0) = 0
  eq("gj moved a screen row", e.cursor, 4);
  e.feed("l"); e.feed("l");                    // now at 6, wish still 0? no: l resets it
  e.feed("g"); e.feed("j");
  const beforeClick = e.cursor;
  e.setCursorFromHost(2);                      // what a click does: x = 20
  eq("the click moved the cursor", e.cursor, 2);
  e.feed("g"); e.feed("j");
  eq("gj uses the CLICKED column, not the old wish", e.cursor, 6);
  eq("...and it did move from the clicked row", e.cursor !== beforeClick, true);
}
{
  // g$ sets the end-of-row wish; a click has to clear that too.
  const text = "abcdefghij\n";
  const e = mk(text, 0, { metrics: wrapMetrics(text, 4) });
  e.feed("g"); e.feed("$");                    // wish: end of row
  e.setCursorFromHost(1);                      // click on the second character
  e.feed("g"); e.feed("j");
  eq("after a click gj lands on the clicked column, not the row end", e.cursor, 5);
}
{
  // j/k keep their own wish, also reset by a click
  const text = "abcdefghij\nklmnopqrst\n";
  const e = mk(text, 0);
  e.feed("l"); e.feed("l"); e.feed("l");       // column 3
  e.feed("j");                                 // line 2, column 3
  eq("j kept column 3", e.cursor, 14);
  e.setCursorFromHost(11);                     // click on line 2, column 0
  e.feed("k");
  eq("k after a click uses the clicked column (0), not the old wish (3)", e.cursor, 0);
}

{
  // With 'wrap' off the screen line is only the VISIBLE part of a long line, so g0/g$/
  // g^ are relative to that window (measured: vim's :help g0). The host reports the
  // window as a character range on the cursor's line.
  const text = "0123456789 abcdefghij ABCDEFGHIJ\nsecond line\n";
  const mkWin = (from, to) => new Engine({ hscroll: () => ({ from, to }) });
  // offsets: "0123456789" is 0-9, space at 10, "abcdefghij" 11-20, space at 21,
  // "ABCDEFGHIJ" 22-31, newline at 32. A window of 21..27 starts ON the space.
  const e = mkWin(21, 27);
  e.setText(text, 0);
  e.feed("g"); e.feed("0");
  eq("g0 goes to the first character in the window", e.cursor, 21);
  e.feed("g"); e.feed("$");
  eq("g$ goes to the last character in the window", e.cursor, 27);
  e.feed("g"); e.feed("^");
  eq("g^ goes to the first non-blank inside the window", e.cursor, 22);
  e.feed("0");
  eq("0 is still the line start", e.cursor, 0);
  e.feed("$");
  eq("$ is still the line end", e.cursor, 31);

  const noWindow = new Engine({});
  noWindow.setText(text, 0);
  noWindow.feed("g"); noWindow.feed("0");
  eq("without a window g0 is the line start", noWindow.cursor, 0);
  noWindow.feed("g"); noWindow.feed("$");
  eq("...and g$ the line end", noWindow.cursor, 31);
  noWindow.feed("l"); noWindow.feed("g"); noWindow.feed("^");
  eq("...and g^ the first non-blank of the line", noWindow.cursor, 0);
}

console.log("\n\x1b[1minsert-mode C-w and C-u: what a keystroke differential cannot see\x1b[0m");
{
  // Consumption. The differential compares text and cursor, so it cannot see the one
  // property that decides whether the browser acts on the key at all: both commands
  // must be HANDLED even when there is nothing to delete. An unconsumed Ctrl-W closes
  // the tab (or the PWA window, or the Electron app) and an unconsumed Ctrl-U is the
  // browser's own command - the same reasoning that makes the first `<C-r>`
  // unconditional. A no-op that returns handled:false is a data-loss bug.
  const e = mk("abc\n");
  e.feed("i");
  eq("C-w at column 1 of the first line is consumed", e.feed("C-w").handled, true);
  eq("...and changed nothing", e.hostText, "abc");
  eq("C-u at column 1 of the first line is consumed", e.feed("C-u").handled, true);
  eq("...and changed nothing either", e.hostText, "abc");

  const empty = mk("");
  empty.feed("i");
  eq("C-w in an empty buffer is consumed", empty.feed("C-w").handled, true);
  eq("C-u in an empty buffer is consumed", empty.feed("C-u").handled, true);

  // Column 1 with a line above it: vim JOINS the previous line here, and this engine
  // deliberately does not (docs/ENGINE.md, "what is deliberately not covered"). The
  // break has to be visible at the API: the key is consumed, and the text is untouched.
  const colOne = mk("abc\ndef\n", 0);
  colOne.feed("j");
  colOne.feed("i");
  eq("C-w at column 1 is consumed", colOne.feed("C-w").handled, true);
  eq("...and does NOT join the line above, by design", colOne.hostText, "abc\ndef");
  eq("C-u at column 1 is consumed too", colOne.feed("C-u").handled, true);
  eq("...and also does not join", colOne.hostText, "abc\ndef");

  // Undo granularity: the deletion belongs to the INSERT, so Esc then one `u` puts the
  // whole thing back - it must not become its own step. (An insert whose net effect is
  // nothing is not a step at all, which is why this one types again after the C-w.)
  const u = mk("abc def\n");
  u.feed("A");
  u.feed("x"); u.applyHostEdit("abc defx", 8);
  u.feed("C-w");
  u.feed("Z"); u.applyHostEdit("abc defZ", 8);
  u.feed("Esc");
  eq("a C-w inside an insert is one undo step, not two", u.undoStack.length, 1);
  u.feed("u");
  eq("one u restores the line", u.hostText, "abc def");
}
{
  // REPLACE mode: the deletion has to UN-type, which means the snapshot's characters
  // come back - and the session must be left consistent, because the next host edit is
  // reconstructed from it. A session that still thinks "XY" was typed rebuilds a buffer
  // containing text the user deleted, which is how a "delete" turns into an insert.
  const e = mk("abcdef\n");
  const type = (ch) => {
    const v = e.hostText;
    const c = Math.min(e.cursor, v.length);
    e.applyHostEdit(v.slice(0, c) + ch + v.slice(c), c + 1);
  };
  e.feed("l"); e.feed("l");
  e.feed("R");
  type("X"); type("Y");
  eq("R over 'cd' writes 'XY' over it", e.hostText, "abXYef");
  e.feed("C-w");
  eq("C-w un-types them and restores what they displaced", e.hostText, "abcdef");
  eq("...leaving the cursor where the deletion began", e.cursor, 2);
  type("Z");
  eq("typing after it still replaces in place", e.hostText, "abZdef");

  // Nothing typed yet: there is nothing to un-type, so pre-existing text is OUT of
  // reach rather than deleted. vim leaves no text change here either (it does move its
  // cursor; that one pixel of divergence is recorded in ENGINE.md).
  const r = mk("abc def\n");
  r.feed("l"); r.feed("l");
  r.feed("R");
  r.feed("C-w");
  eq("C-w in replace mode with nothing typed deletes nothing", r.hostText, "abc def");
}

console.log("\n\x1b[1mcase operators: the parts a keystroke differential cannot see\x1b[0m");
{
  // A differential compares text and cursor. It cannot see whether a command that changed
  // NOTHING became an undo step, and it cannot see that `gUiw` is not a yank - both of
  // which the user feels immediately.
  const e = mk("alpha beta\n");
  e.feedKeys("gUiw");
  eq("gUiw uppercases the word", e.hostText, "ALPHA beta");
  eq("...and leaves the cursor on its first character", e.cursor, 0);

  const noop = mk("ALPHA beta\n");
  noop.feedKeys("gUiw");
  eq("an all-uppercase gUiw changes no text", noop.hostText, "ALPHA beta");
  eq("...and costs no undo step", noop.undoStack.length, 0);

  const yanked = mk("alpha beta\n");
  yanked.feedKeys('"ayw');        // yank into register a (whatever yw covers exactly)
  const registerBefore = yanked.registers.read("a").text;
  yanked.feedKeys("wgUiw");       // uppercase "beta" - must not touch any register
  eq("gUiw changes the text", yanked.hostText, "alpha BETA");
  eq("...and is NOT a yank: the named register is byte-for-byte what it was",
    yanked.registers.read("a").text, registerBefore);

  // The doubled form is checked before `u` reaches undo, which is the whole reason it
  // needs its own branch: `2guu` must lowercase two lines, not undo twice.
  const doubled = mk("AB\nCD\nEF\n");
  doubled.feedKeys("2guu");
  eq("2guu lowercases two lines and does not touch undo", doubled.hostText, "ab\ncd\nEF");
  eq("...creating exactly one undo step", doubled.undoStack.length, 1);
}

console.log("\n\x1b[1mthe :e / :w / :q session commands\x1b[0m");
{
  // The ex layer drives the editor transport. Nothing had ever run these three together,
  // so the session API's write/close were dead as far as the suite was concerned.
  const calls = [];
  const session = {
    open: () => { calls.push("open"); return { ok: true, message: "" }; },
    write: () => { calls.push("write"); return { ok: true, message: "" }; },
    close: (bang) => { calls.push(`close:${!!bang}`); },
  };
  const e = mk("x\n", 0, { session });
  e.feed(":"); e.submitPrompt("e");
  eq(":e opens the transport", calls, ["open"]);
  e.feed(":"); e.submitPrompt("w");
  eq(":w writes", calls, ["open", "write"]);
  e.feed(":"); e.submitPrompt("wq");
  eq(":wq writes then closes", calls.slice(-2), ["write", "close:false"]);
  e.feed(":"); const q = e.submitPrompt("q");
  eq(":q with a session closes it", calls.slice(-1), ["close:false"]);
  eq("...and does NOT ask the host to detach the field", q.quit, false);
  e.feed(":"); e.submitPrompt("q!");
  eq(":q! closes with bang", calls.slice(-1), ["close:true"]);
}
{
  // A field is not a file: :e with an argument and :w with no transport must say so.
  const e = mk("x\n");
  e.feed(":"); eq(":e with a filename is refused", /no file/.test(e.submitPrompt("e foo.txt").ex.message), true);
  e.feed(":"); eq(":e without a transport says so", /no editor transport/.test(e.submitPrompt("e").ex.message), true);
  e.feed(":"); eq(":w without a transport says so", /no editor transport/.test(e.submitPrompt("w").ex.message), true);
  e.feed(":");
  // A transport exists on every field (that is what makes :e possible) but an IDLE one
  // must not swallow :q — that is the field-detach case, not a close.
  const idle = mk("x\n", 0, { session: { isOpen: () => false, close: () => { calls.push("closed-idle"); } } });
  idle.feed(":");
  eq("an idle session does not swallow :q", idle.submitPrompt("q").quit, true);
  const quit = e.submitPrompt("q");
  eq(":q with no session asks the HOST to leave this field alone", quit.quit, true);
  eq("...and is not an error", quit.ex.ok, true);
  e.feed(":"); const bang = e.submitPrompt("q!");
  eq(":q! does the same", bang.quit, true);
}

console.log("\n\x1b[1mthe host-facing engine API (a coverage sweep found these unrun)\x1b[0m");
{
  // A DOM caret is a position BETWEEN characters; vi's cursor is a character, and a
  // caret sitting on a newline has to clamp back onto the line.
  const e = mk("abc\ndef\n");
  e.setCursorFromHost(5);
  eq("setCursorFromHost adopts the host caret", e.cursor, 5);
  e.setCursorFromHost(3);
  eq("...and clamps a caret sitting on the newline", e.cursor, 2);
  // A caret move with no text change is its own host event (arrow keys, a click, an IME
  // caret jump): adopt the caret and change nothing. Nothing had ever run this path.
  e.feedKeys("i");
  e.applyHostEdit(e.hostText, 4);
  eq("a caret-only host edit moves the cursor and keeps the text", [e.cursor, e.hostText], [4, "abc\ndef"]);
}
{
  // The mouse path: a drag becomes VISUAL, a click inside an existing selection trims it.
  const e = mk("abcdef\nghij\n", 0);
  e.enterVisualFromHost(1, 4);
  eq("a drag opens VISUAL", e.mode, "VISUAL");
  eq("...with the dragged text selected", e.visualText(), "bcde");
  e.extendVisualToClick(2, 1, 4);
  eq("a click inside the selection moves the near boundary", e.visualText(), "cde");
  e.extendVisualToClick(4, 1, 4);
  eq("a click after the selection keeps its start", e.visualText(), "bcde");
}
{
  // reset() is what an adapter calls when it lets go of a field.
  const e = mk("abc\n");
  e.feed(":"); e.mode = "VISUAL";
  e.reset();
  eq("reset returns to NORMAL", e.mode, "NORMAL");
  eq("...and drops the prompt", e.prompt, null);
  eq("...and the visual anchor", e.visual, null);
}
{
  const scrolled = [];
  const host = { viewport: () => ({ top: 0, height: 3 }), onScroll: (line) => scrolled.push(line) };
  const e = mk("l1\nl2\nl3\nl4\nl5\n", 0, host);
  e.feed("C-e");
  eq("C-e asks the host to scroll one line down", scrolled, [1]);
  // ...and the cursor is pushed down with the window, because it was on the top line.
  eq("...taking the cursor with it", e.text.slice(0, e.cursor).split("\n").length, 2);
  e.feed("C-y");
  eq("C-y asks for one line up", scrolled, [1, 0]);
  // The cursor is the host's to move once the window moves: we can only ask for the
  // scroll, and every adapter re-reads the viewport afterwards.
  const bare = mk("a\nb\n");
  bare.feed("C-e");
  eq("C-e without a viewport reports it", /no viewport on this host/.test(bare.status.slice(-1)[0] || ""), true);
  // A host may set a viewport and no scroll callback at all: the default sink must exist
  // (it is the one never-entered function left in engine.js after the sweep).
  const quiet = mk("a\nb\n", 0, { viewport: () => ({ top: 0, height: 2 }) });
  quiet.feed("C-e");
  eq("a viewport with no onScroll is harmless", quiet.status.length, 0);
  // vim keeps the cursor INSIDE the window: C-e pushes it down off the top, C-y pushes
  // it up off the bottom, and a scroll that leaves it visible leaves it alone.
  const win = { top: 0, height: 3 };
  const lines = "l1\nl2\nl3\nl4\nl5\nl6\n";
  const scroll = mk(lines, 0, { viewport: () => ({ ...win }), onScroll: (t) => { win.top = t; } });
  const lineOf = (e) => e.text.slice(0, e.cursor).split("\n").length;
  scroll.feed("C-e");
  eq("C-e scrolls and takes the cursor with it", [win.top, lineOf(scroll)], [1, 2]);
  scroll.feed("C-e");
  eq("...and again, one row at a time", [win.top, lineOf(scroll)], [2, 3]);
  scroll.feed("C-y");
  eq("C-y scrolls back and leaves a visible cursor alone", [win.top, lineOf(scroll)], [1, 3]);
  const bottom = { top: 5, height: 3 };
  const down = mk("l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n", 0, { viewport: () => ({ ...bottom }), onScroll: (t) => { bottom.top = t; } });
  down.feedKeys("7j");
  eq("the cursor sits on the window's last row", lineOf(down), 8);
  down.feed("C-y");
  eq("C-y pushes it up into the window", [bottom.top, lineOf(down)], [4, 7]);
}
{
  const e = mk("hello world\nsecond\n", 0);
  e.feed("C-g");
  eq("^G reports line, column and character count",
    /line 1 of 2 · col 1 · 19 chars/.test(e.status.slice(-1)[0] || ""), true);
}
{
  const e = mk("x\n");
  e.feed(":");
  const r = e.submitPrompt("set");
  eq(":set with no arguments lists the options", /autoindent/.test(r.ex.message), true);
}

console.log("\n\x1b[1mtheme detection (adapters/theme.js)\x1b[0m");
{
  // Which palette a page needs is a contrast question, not a taste question: text goes
  // dark where dark text has the better contrast ratio against that background.
  eq("white is a light page", themeFromColor("rgb(255,255,255)"), "light");
  eq("the dark fixture is a dark page", themeFromColor("rgb(30,30,30)"), "dark");
  eq("mid-gray #767676 reads better with dark text", themeFromColor("rgb(118,118,118)"), "light");
  eq("...and #6f6f6f tips the other way", themeFromColor("rgb(111,111,111)"), "dark");
  eq("a transparent colour is not a surface", themeFromColor("rgba(255,255,255,0)"), null);
  eq("an unparsable colour is not a surface", themeFromColor("not-a-colour"), null);
  eq("the switch point is the equal-contrast luminance",
    Math.abs(LIGHT_SWITCH - 0.1791) < 0.001, true);

  // The invariant that makes the light palette worth having: every text colour in both
  // palettes is readable on its own surface (WCAG AA, 4.5:1). A palette that fails this
  // is not "adapted", it is a second way of being invisible.
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(parseColor(a)), luminance(parseColor(b))].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  for (const [name, set] of Object.entries(THEMES)) {
    for (const key of ["--jsbarevi-ui-fg", "--jsbarevi-ui-accent", "--jsbarevi-ui-error", "--jsbarevi-ui-prompt"]) {
      const ratio = contrast(set[key], set["--jsbarevi-ui-bg"]);
      eq(`${name} ${key} is readable on the chip (${ratio.toFixed(1)}:1)`, ratio >= 4.5, true);
    }
    // A caret painted in the same colour as the field is not a caret. The light set has
    // to be materially darker, which is the whole point of the second palette.
    const caretOnPage = contrast(set["--jsbarevi-caret-border"], name === "light" ? "#ffffff" : "#1e1e1e");
    eq(`${name} caret stands out from the page (${caretOnPage.toFixed(1)}:1)`, caretOnPage >= 3, true);
  }
}


// ---------------------------------------------------------------------------
// The native-shortcut contract: refused, delegated, or simulated.
// ---------------------------------------------------------------------------
console.log("\n\x1b[1mnative shortcuts: refused, delegated, or simulated\x1b[0m");
{
  const msgs = [];
  const e = mk("alpha beta\n", 0, { onStatus: (m, k) => msgs.push([m, k]) });
  e.feed("C-v");
  eq("Ctrl-V in NORMAL is refused, not pasted", msgs.at(-1), ["block visual: not implemented", "error"]);
  e.feed("C-q");
  eq("Ctrl-Q (vim's alias) gets the same refusal", msgs.at(-1), ["block visual: not implemented", "error"]);
  eq("...and neither touched the text", e.text, "alpha beta\n");
}
{
  const msgs = [];
  const e = mk("alpha beta\n", 0, { onStatus: (m, k) => msgs.push([m, k]) });
  for (const k of ["q", "@", "Q"]) {
    e.feed(k);
    eq(`${k} is refused as a macro`, msgs.at(-1), ["macros: not implemented", "error"]);
  }
}
{
  // Charwise visual delegates to the browser: the adapter must NOT consume these.
  const e = mk("alpha beta\n", 0);
  e.feed("v");
  for (const k of ["C-a", "C-x", "C-v", "C-c"]) {
    eq(`${k} is the browser's in charwise visual`, e.feed(k).handled, false);
  }
}
{
  // VISUAL LINE has no native selection to act on, so the same keys are simulated.
  const writes = [];
  const e = mk("a1\nb2\nc3\n", 0, { clipboard: { read: () => null, write: (t) => writes.push(t) } });
  e.feed("V"); e.feed("C-a");
  eq("Ctrl-A in VISUAL LINE selects every line", e.visualText(), "a1\nb2\nc3\n");
  eq("...and stays linewise", e.mode, Mode.VISUAL_LINE);
}
{
  const writes = [];
  const e = mk("a1\nb2\nc3\n", 0, { clipboard: { read: () => null, write: (t) => writes.push(t) } });
  e.feed("V"); e.feed("C-c");
  eq("Ctrl-C in VISUAL LINE copies the line with its break", writes.at(-1), "a1\n");
  eq("...and leaves the text alone", e.text, "a1\nb2\nc3\n");
}
{
  const writes = [];
  const e = mk("a1\nb2\nc3\n", 0, { clipboard: { read: () => null, write: (t) => writes.push(t) } });
  e.feed("V"); e.feed("C-x");
  eq("Ctrl-X in VISUAL LINE cuts the line out", e.text, "b2\nc3\n");
  eq("...onto the clipboard", writes.at(-1), "a1\n");
  eq("...and leaves visual mode", e.mode, Mode.NORMAL);
}
{
  const e = mk("a1\nb2\n", 0, { clipboard: { read: () => "ZZ", write: () => {} } });
  e.feed("V"); e.feed("C-v");
  eq("Ctrl-V in VISUAL LINE pastes over the selected line", e.text, "ZZ\nb2\n");
}
{
  // The Insert key's own cycle: normal -> insert -> replace -> insert.
  const e = mk("ab\n", 0);
  e.feed("Insert");
  eq("Insert in normal mode enters insert", e.mode, Mode.INSERT);
  eq("...with no replace session", e.replaceSession, null);
  e.feed("Insert");
  eq("Insert in insert mode starts replace", typeof e.replaceSession, "object");
  e.feed("Insert");
  eq("Insert again returns to plain insert", e.replaceSession, null);
  eq("...still inserting", e.mode, Mode.INSERT);
}
{
  const { shiftMotionFor } = await import("../src/adapters/keys.js");
  const ev = (key) => ({ key, shiftKey: true, altKey: false, ctrlKey: false, metaKey: false });
  eq("shift+Down in VISUAL LINE is the engine's j", shiftMotionFor(ev("ArrowDown"), Mode.VISUAL_LINE), "j");
  eq("shift+End in VISUAL LINE is g$", shiftMotionFor(ev("End"), Mode.VISUAL_LINE), "g$");
  eq("...and in charwise visual it stays the host's", shiftMotionFor(ev("ArrowDown"), Mode.VISUAL), null);
  eq("...as it does in normal mode", shiftMotionFor(ev("ArrowDown"), Mode.NORMAL), null);
}

{
  const { fromField } = await import("../src/engine/buffer.js");
  const e = mk("alpha beta\n", 0);
  const before = e.text;
  e.applyHostEdit("alpha\n", 5);            // the host cut " beta" behind our back
  e.recordHostEdit(before, 0);
  e.feed("u");
  eq("a host edit recorded with recordHostEdit is undoable", e.hostText, "alpha beta");
  void fromField;
}

{
  const { tokenFor } = await import("../src/adapters/keys.js");
  const ev = (key, mods = {}) => ({ key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...mods });
  eq("plain Insert is the engine's (the replace toggle)", tokenFor(ev("Insert"), Mode.INSERT), "Insert");
  eq("Shift+Insert is the HOST's paste", tokenFor(ev("Insert", { shiftKey: true }), Mode.INSERT), null);
  eq("Ctrl+Insert is the HOST's copy", tokenFor(ev("Insert", { ctrlKey: true }), Mode.INSERT), null);
  eq("Shift+Delete is the HOST's cut", tokenFor(ev("Delete", { shiftKey: true }), Mode.INSERT), null);
  eq("Shift+Insert in VISUAL LINE is the engine's paste", tokenFor(ev("Insert", { shiftKey: true }), Mode.VISUAL_LINE), "C-v");
  eq("Ctrl+Insert in VISUAL LINE is the engine's copy", tokenFor(ev("Insert", { ctrlKey: true }), Mode.VISUAL_LINE), "C-c");
  eq("Shift+Delete in VISUAL LINE is the engine's cut", tokenFor(ev("Delete", { shiftKey: true }), Mode.VISUAL_LINE), "C-x");
  eq("...and the same three in charwise visual", [
    tokenFor(ev("Insert", { shiftKey: true }), Mode.VISUAL),
    tokenFor(ev("Insert", { ctrlKey: true }), Mode.VISUAL),
    tokenFor(ev("Delete", { shiftKey: true }), Mode.VISUAL),
  ], [null, null, null]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
