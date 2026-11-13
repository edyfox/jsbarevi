#!/usr/bin/env node
// Undo audit: a second axis over the alignment matrix.
//
// audit-align.mjs asks "does one command leave the buffer vim would leave?". It
// cannot see any rule that only exists across two commands - which is exactly
// where the `s` + Esc + `u` bug lived (the deletion and the insert were recorded
// as two undo steps, so the first `u` only moved the cursor). The unit of undo in
// vim is the CHANGE COMMAND, so the invariant is:
//
//     if C changed the text, then C u restores it exactly.
//
// That needs no reference editor to check: it is a property of undo itself, and
// the cases where vim is the authority are already pinned in oracle/cases. So
// this audit only runs our engine, which is why it is cheap enough to sit in
// `npm test`. `--vim` adds the reference comparison for a spot check.
//
// Diagnostic, not a gate: prints the failing combinations and exits non-zero.

import { runOurs, runVim, compare, normalise } from "../test/lib/engine-driver.mjs";
import { COMMANDS, combinations, parseArgs } from "./alignment-matrix.mjs";

const args = parseArgs();
const withVim = args.has("--vim");
const showAll = args.has("--all");
const commands = args.commandFilter(COMMANDS);

let total = 0;
let checked = 0;
const failures = new Map(); // command -> [{ shape, posName, keys, why }]

for (const { shape, posName, input, cmd, keys } of combinations(commands)) {
  total++;
  // The driver hands back the host view (one trailing newline removed), so the
  // baseline has to be the same view of the input - otherwise the "\n" shape
  // looks changed before anything happens.
  const baseline = normalise(input);
  const changed = runOurs(input, keys);
  // Only a command that actually edited the buffer has anything to undo; `u` on
  // a fresh buffer, a cursor motion or `r<Esc>` is not a change and must not be
  // counted (an empty insert is deliberately NOT an undo step either).
  if (changed.text === baseline) continue;
  checked++;

  const undone = runOurs(input, `${keys}u`);
  const why = [];
  if (undone.text !== baseline) {
    why.push(`text ${JSON.stringify(undone.text)} != ${JSON.stringify(baseline)}`);
  }
  if (withVim) {
    let vim;
    try {
      vim = runVim(input, `${keys}u`, { options: { expandtab: true, shiftwidth: 4, tabstop: 4 } });
    } catch {
      vim = null; // vim refused the sequence; nothing to compare
    }
    if (vim) {
      const diffs = compare(undone, vim);
      if (diffs.length) why.push(...diffs.map((d) => `vs vim: ${d}`));
    }
  }
  if (!why.length) continue;
  if (!failures.has(cmd)) failures.set(cmd, []);
  failures.get(cmd).push({ shape, posName, keys, why });
}

const differing = [...failures.values()].reduce((n, v) => n + v.length, 0);
console.log(`\n${total} combinations, ${checked} changed the buffer, ${differing} did not undo${withVim ? " (compared with vim too)" : ""}\n`);

const ranked = [...failures.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [cmd, hits] of ranked) {
  console.log(`\x1b[1m${cmd}\x1b[0m  (${hits.length})`);
  for (const h of showAll ? hits : hits.slice(0, 4)) {
    console.log(`   ${h.shape.padEnd(16)} at ${h.posName.padEnd(8)} keys=${JSON.stringify(h.keys)}`);
    for (const w of h.why) console.log(`      \x1b[31m${w}\x1b[0m`);
  }
  if (!showAll && hits.length > 4) console.log(`   ... ${hits.length - 4} more (--all for the full list)`);
}
process.exit(ranked.length ? 1 : 0);
