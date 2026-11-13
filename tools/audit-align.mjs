#!/usr/bin/env node
// Alignment audit: run a generated matrix of (buffer shape x cursor position x
// command) through real vim and through our engine, and report which commands
// disagree. The point is coverage by construction - bugs have so far appeared in
// the gaps between hand-written cases (empty line, column 1, last column).
//
// This is a diagnostic, not a gate: it prints a table and exits non-zero when it
// finds differences. Anything it finds should become a permanent case in
// oracle/cases/ before it is fixed.

import { runVim, runOurs, compare } from "../test/lib/engine-driver.mjs";

const SHAPES = {
  "empty": "",
  "one-empty-line": "\n",
  "one-line": "ab\n",
  "two-lines": "abc\ndef\n",
  "blank-middle": "a\n\nb\n",
  "indented": "  ab\ncd\n",
  "words": "one two three\nfour five\n",
  "brackets": "f(x) y\n[z]\n",
  "last-line-no-eol": "abc\ndef",
};

// A short path to a starting position; "" means column 1 of line 1.
const POSITIONS = {
  "1:1": "",
  "1:last": "$",
  "2:1": "j",
  "2:last": "j$",
  "last:1": "G",
  "mid": "ll",
};

// Commands that touch a boundary, a count, or a cursor placement rule.
const COMMANDS = [
  "x", "X", "D", "dd", "yy", "p", "P", "J", "~", "rq", "2x", "3~",
  "w", "b", "e", "dw", "de", "db", "d$", "d0",
  "cwZ<Esc>", "ccZ<Esc>", "yyP", ">j", "<j", "u", ".",
  "iZ<Esc>", "aZ<Esc>", "IZ<Esc>", "AZ<Esc>", "oZ<Esc>", "OZ<Esc>", "3iZ<Esc>",
  "0", "^", "G", "gg", "h", "l", "j", "k",
  "2J", "r<Esc>", "%",
];

const args = process.argv.slice(2);
const showAll = args.includes("--all");
const only = args.find((a) => !a.startsWith("--"));
const commands = only ? COMMANDS.filter((c) => c.includes(only)) : COMMANDS;

let total = 0;
const failures = new Map(); // command -> [{ shape, position, diffs }]

for (const [shape, input] of Object.entries(SHAPES)) {
  for (const [posName, pos] of Object.entries(POSITIONS)) {
    for (const cmd of commands) {
      const keys = pos + cmd;
      total++;
      let vim;
      try {
        // match our documented indent defaults instead of vim's tab
        vim = runVim(input, keys, { options: { expandtab: true, shiftwidth: 4, tabstop: 4 } });
      } catch {
        continue; // vim itself refused the sequence; nothing to compare
      }
      const ours = runOurs(input, keys);
      const diffs = compare(ours, vim);
      if (diffs.length) {
        if (!failures.has(cmd)) failures.set(cmd, []);
        failures.get(cmd).push({ shape, posName, keys, input, diffs });
      }
    }
  }
}

console.log(`\n${total} combinations, ${[...failures.values()].reduce((n, v) => n + v.length, 0)} differ\n`);
const ranked = [...failures.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [cmd, hits] of ranked) {
  console.log(`\x1b[1m${cmd}\x1b[0m  (${hits.length} of ${Object.keys(SHAPES).length * Object.keys(POSITIONS).length})`);
  // --all prints every differing combination: the truncated default is readable
  // but not a worklist, and re-deriving the full list by hand is how you fix 17
  // symptoms instead of the 2 causes behind them.
  for (const h of showAll ? hits : hits.slice(0, 4)) {
    console.log(`   ${h.shape.padEnd(16)} at ${h.posName.padEnd(8)} keys=${JSON.stringify(h.keys)}`);
    console.log(`      input=${JSON.stringify(h.input)}`);
    for (const d of h.diffs) console.log(`      \x1b[31m${d}\x1b[0m`);
  }
  if (!showAll && hits.length > 4) console.log(`   ... ${hits.length - 4} more (--all for the full list)`);
}
process.exit(ranked.length ? 1 : 0);
