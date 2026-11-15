// Fill a case file's `expect` blocks from the reference editor.
//
// Why this exists: every hand-typed expectation this project has produced has, at
// least once, been wrong in a way that made correct engine behaviour look broken
// (six shifted `>>`/`<<` columns on 2026-11-14, and a trailing-newline convention
// before that). So the rule is `expect` is GENERATED from vim, never typed - this
// script is the generator, so the rule is one command instead of a habit.
//
// Usage:
//   node tools/gen-expect.mjs oracle/cases/insert-backspace.json          # show
//   node tools/gen-expect.mjs --write oracle/cases/insert-backspace.json  # write
//
// A case is skipped when it is explicitly not a differential case (`noDifferential`)
// or when it restricts itself to engines that do not include vim, because vim is the
// behaviour oracle. `line`/`col` are omitted for `noPosition` cases, matching what
// test/differential.mjs compares.

import fs from "node:fs";
import path from "node:path";
import { runVim } from "../test/lib/engine-driver.mjs";

const args = process.argv.slice(2);
const write = args.includes("--write");
const files = args.filter((a) => !a.startsWith("--"));
if (!files.length) {
  console.error("usage: node tools/gen-expect.mjs [--write] <case-file.json> [...]");
  process.exit(2);
}

let changed = 0;
for (const file of files) {
  const spec = JSON.parse(fs.readFileSync(file, "utf8"));
  let touched = 0;
  for (const c of spec.cases) {
    if (c.noDifferential) continue;
    if (c.engines && !c.engines.includes("vim")) continue;
    const out = runVim(c.input, c.keys, { options: c.options || {} });
    // `raw`, not `text`: case files hold the text vim WROTE, and the engine test strips
    // one terminator from each side exactly as the differential does. Writing the
    // already-stripped form here made a case whose last line is empty disagree with
    // itself (one newline stripped twice).
    const expect = { text: out.raw };
    if (!c.noPosition) { expect.line = out.line; expect.col = out.col; }
    const before = JSON.stringify(c.expect ?? null);
    const after = JSON.stringify(expect);
    if (before !== after) {
      touched++;
      changed++;
      console.log(`  ${path.basename(file)} :: ${c.name}\n      ${before} -> ${after}`);
    }
    c.expect = expect;
  }
  if (touched) {
    console.log(`  ${path.basename(file)}: ${touched} expectation(s) ${write ? "rewritten" : "differ"}`);
    if (write) fs.writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`);
  } else {
    console.log(`  ${path.basename(file)}: all expectations already match vim`);
  }
}
console.log(`\n${changed} expectation(s) ${write ? "written" : "differ from vim"}`);
process.exit(0);
