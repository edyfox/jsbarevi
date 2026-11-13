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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
