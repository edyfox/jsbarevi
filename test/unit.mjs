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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
