// The register MATRIX: every way a command can write a register, crossed with every
// register we support.
//
// Why this exists: `"+yy` worked and `"+yaw` silently did not, because the operator+
// text-object path threw the register away and no test looked at that pair. Fixing the
// one cell a human happened to hit is whack-a-mole; enumerating the grid is the answer.
//
// Two axes, two oracles — deliberately different, because they answer different
// questions and only one of them can be answered by vim:
//
//   1. `"a{form}` against real vim: the register must carry the text VIM carries, and
//      pasting it must reproduce vim's buffer. This is the axis that catches "this
//      command path never looks at the prefix".
//   2. The other names against an INVARIANT (vim -es has no clipboard, so this half is
//      not a differential): `+` must carry what `a` carries, `A` must append, `_` must
//      write nothing, and an unsupported name must abort the command rather than
//      half-running it.
//
// Three ways to place a register, because vim has three (and a matrix that assumes one
// of them is how the `:y` row crashed vim the first time this ran):
//
//   * prefix, before the command          `"ayaw`, `"add`, `"adG`
//   * inside VISUAL mode, before the op   `vll"ay`
//   * as an ARGUMENT to an ex command     `:y a`, `:d a`
//
//   node test/registers-matrix.mjs
//
// Position is not compared here: the differential case files pin cursor behaviour per
// command, and mixing the two turns one register failure into two.

import { Engine } from "../src/engine/engine.js";
import { runVim, normalise } from "./lib/engine-driver.mjs";

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`);
    console.log(`       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
    fail++;
  } else pass++;
};

const DEFAULT_INPUT = "alpha beta gamma\ndelta epsilon\nzeta eta theta\n";
const PAREN_INPUT = "call(a, b)\nsecond line\n";
const COMMA_INPUT = "alpha,beta\nsecond line\n";
const PARA_INPUT = "alpha beta\n\nbeta gamma\n";
const BRACE_INPUT = "x{ y }\nsecond line\n";
const QUOTE_INPUT = "say \"hello there\" now\nsecond line\n";
const PARAGRAPH_INPUT = "a\nb\n\nc\nd\n";

/**
 * Every command form that WRITES a register — one per engine code path.
 *
 *   prep     cursor setup, run before the command (and before the register)
 *   insert   the form enters insert mode, so the paste needs `<Esc>` first
 *   op       visual forms: the final operator, which takes the register prefix
 *   ex       ex forms: the register is an ARGUMENT (`:y a`), not a prefix
 */
const FORMS = [
  // --- operator doubled (linewise): the `yy` family ----------------------
  { name: "yy", body: "yy" },
  { name: "dd", body: "dd" },
  { name: "cc", body: "cc", insert: true },
  { name: "Y", body: "Y" },
  { name: "D", body: "D" },
  { name: "C", body: "C", insert: true },
  { name: "S", body: "S", insert: true },

  // --- operator + motion ------------------------------------------------
  { name: "yw", body: "yw" },
  { name: "y$", body: "y$" },
  { name: "yb", body: "yb", prep: "lll" },
  { name: "yk", body: "yk", prep: "j" },
  { name: "yG", body: "yG" },
  { name: "ygg", body: "ygg", prep: "G" },
  { name: "y%", body: "y%", input: PAREN_INPUT, prep: "4l" },
  { name: "yt,", body: "yt,", input: COMMA_INPUT },
  { name: "d}", body: "d}", input: PARA_INPUT },
  // This cell used to be a KNOWN DIVERGENCE (vim runs `d}` to end-of-buffer from an empty
  // line, we stopped at the paragraph end). Fixed 2026-11-14: the motion now reports the
  // raw end, so the grid runs it like any other cell.
  { name: "d}\u200b(empty line)", body: "d}", input: PARAGRAPH_INPUT, prep: "jj" },
  { name: "d(", body: "d(", input: PAREN_INPUT, prep: "5l" },
  { name: "dG", body: "dG" },
  { name: "d'a", body: "d'a", prep: "maG" },
  { name: "dgj", body: "dgj" },
  { name: "yg0", body: "yg0", prep: "w" },

  // --- operator + text object: the family that hid the bug --------------
  { name: "yaw", body: "yaw" },
  { name: "yiw", body: "yiw" },
  { name: "ya\"", body: "ya\"", input: QUOTE_INPUT, prep: "6l" },
  { name: "yap", body: "yap" },
  { name: "ya(", body: "ya(", input: PAREN_INPUT, prep: "5l" },
  { name: "yi{", body: "yi{", input: BRACE_INPUT, prep: "2l" },
  { name: "diw", body: "diw" },
  { name: "daw", body: "daw" },
  { name: "ciw", body: "ciw", insert: true },
  { name: "caw", body: "caw", insert: true },

  // --- single-key deletes ----------------------------------------------
  { name: "x", body: "x" },
  { name: "X", body: "X", prep: "lll" },
  { name: "s", body: "s", insert: true },

  // --- visual: the register goes before the operator --------------------
  { name: "v..y", body: "vlll", op: "y" },
  { name: "V..d", body: "V", op: "d" },
  { name: "v..c", body: "vll", op: "c", insert: true },
  { name: "v..x", body: "vlll", op: "x" },

  // --- ex commands: the register is an argument -------------------------
  { name: ":y", ex: ":y a<CR>" },
  { name: ":d", ex: ":d a<CR>" },
];

/**
 * A headless host with the capabilities the screen-line motions need, so `g0`/`gj` are
 * exercised the way the adapters supply them instead of degrading to a failure.
 */
const HOST = {
  metrics: (offset) => ({ x: offset, y: 0, width: 1, height: 1 }),
  hscroll: () => ({ from: 0, to: 79 }),
  viewport: () => ({ top: 0, height: 10 }),
};

const engineFor = (input, clipboard) => {
  const e = new Engine({ ...HOST, clipboard });
  e.setText(input, 0);
  return e;
};

const recorder = () => {
  const box = { text: null, writes: 0 };
  box.read = () => box.text;
  box.write = (text) => { box.text = text; box.writes++; };
  return box;
};

const flat = (entry) => (entry ? entry.text.replace(/\n$/, "") : null);

/**
 * Drive one form into an engine, in whichever of the three positions it needs.
 *
 * Ex commands are not keystrokes: `:` opens a PROMPT, and the line is submitted to the
 * ex interpreter, so they cannot go through feedKeys() at all — the matrix's first run
 * typed `:y a` as normal-mode keys and every ex cell reported "nothing stored".
 */
function drive(e, form, reg) {
  if (form.ex) {
    e.feed(":");
    e.submitPrompt(reg ? `${form.ex.slice(1).replace("<CR>", "").replace(" a", ` ${reg}`)}` : form.ex.slice(1).replace("<CR>", ""));
    return;
  }
  e.feedKeys(reg ? withRegister(form, reg) : withoutRegister(form));
}

/** `"a` + form, in whichever of the three positions this form needs. */
function withRegister(form, reg) {
  if (form.ex) return form.ex.replace(" a", ` ${reg}`);
  if (form.op) return form.body + `"${reg}` + form.op;
  return `"${reg}` + form.body;
}

const withoutRegister = (form) => (form.op ? form.body + form.op : form.body);
// `G$` before the paste: a yank can leave the cursor anywhere, and a put turns that
// position into TEXT, so the matrix would fail on cursor placement instead of registers.
const tail = (form) => (form.insert ? "<Esc>" : "") + 'G$"ap';

function run() {
  console.log("\n\x1b[1mregisters x command forms: every cell, every register\x1b[0m");
  for (const form of FORMS) {
    const input = form.input || DEFAULT_INPUT;
    const prep = form.prep || "";
    const seed = '"byy';                       // something in the unnamed register to compare against

    // --- axis 1: `"a`, with vim as the oracle ----------------------------
    const named = engineFor(input, null);
    named.feedKeys(seed + prep);
    drive(named, form, "a");
    const unnamed = named.registers.read();
    const a = named.registers.read("a");
    check(`${form.name}: "a holds exactly what the unnamed register holds`,
      !!a && !!unnamed && a.text === unnamed.text && a.linewise === unnamed.linewise, true);
    check(`${form.name}: the yank/delete carried something`,
      typeof flat(unnamed) === "string" && flat(unnamed).length > 0, true);

    if (!form.ex && !form.knownDivergence) {
      const keys = seed + prep + withRegister(form, "a") + tail(form);
      const vim = runVim(input, keys);
      const mine = engineFor(input, null);
      mine.feedKeys(keys);
      check(`${form.name}: pasting it reproduces vim's buffer`, normalise(mine.text), vim.text);
    }

    // --- axis 2: the rest of the names, by invariant ----------------------
    const clip = recorder();
    const plus = engineFor(input, clip);
    plus.feedKeys(seed + prep);
    drive(plus, form, "+");
    check(`${form.name}: "+ carries the same text as "a`, flat(plus.registers.read()), flat(unnamed));
    check(`${form.name}: ...and reaches the system clipboard`, clip.writes, 1);
    check(`${form.name}: ...with the same payload`, flat({ text: clip.text || "", linewise: false }), flat(unnamed));

    const seeded = engineFor(input, null);
    seeded.feedKeys(seed + prep);
    const seedText = seeded.registers.read()?.text;
    const hole = engineFor(input, null);
    hole.feedKeys(seed + prep);
    drive(hole, form, "_");
    check(`${form.name}: "_ leaves the unnamed register alone`, hole.registers.read()?.text, seedText);
    check(`${form.name}: ...and stores nothing of its own`, hole.registers.read("_"), null);

    const append = engineFor(input, null);
    append.feedKeys(seed + prep + '"ayy');
    const beforeAppend = append.registers.read("a").text;
    drive(append, form, "A");
    check(`${form.name}: "A appends instead of replacing`,
      append.registers.read("a").text.length > beforeAppend.length, true);

    const untouched = engineFor(input, null);
    untouched.feedKeys(seed + prep);            // everything except the command itself
    const bad = engineFor(input, null);
    bad.feedKeys(seed + prep);
    drive(bad, form, "1");
    check(`${form.name}: an unsupported register aborts the command`, bad.hostText, untouched.hostText);
  }

  console.log(`  ${FORMS.length} forms x 9 assertions = ${FORMS.length * 9} cells`);
}

run();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
