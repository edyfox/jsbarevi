// Differential test: the same keystrokes into real `vim -N -u NONE` and into our
// engine, then compare buffer + cursor. No hardcoded expectations - vim is the
// reference at runtime, which is the whole point of the oracle work.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runVim, runOurs, compare } from "./lib/engine-driver.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function main() {
  const files = process.argv.slice(2).length
    ? process.argv.slice(2)
    : fs.readdirSync(path.join(ROOT, "oracle/cases"))
        .filter((f) => f.endsWith(".json"))
        .map((f) => path.join(ROOT, "oracle/cases", f));

  let pass = 0;
  let fail = 0;
  for (const file of files) {
    const spec = JSON.parse(fs.readFileSync(file, "utf8"));
    console.log(`\n\x1b[1m${path.basename(file)}\x1b[0m`);
    for (const c of spec.cases) {
      if (c.noDifferential) continue;
      if (c.engines && !c.engines.includes("vim")) continue;
      let vim;
      try {
        vim = runVim(c.input, c.keys, { options: c.options || {} });
      } catch (err) {
        console.log(`  \x1b[33mERR \x1b[0m ${c.name}: vim failed (${err.message.split("\n")[0]})`);
        fail++;
        continue;
      }
      const ours = runOurs(c.input, c.keys, c.options || {});
      const diffs = compare(ours, vim, { noPosition: !!c.noPosition });
      if (!diffs.length) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${c.name}`); }
      else {
        fail++;
        console.log(`  \x1b[31mFAIL\x1b[0m ${c.name}  keys=${JSON.stringify(c.keys)}`);
        for (const d of diffs) console.log(`       \x1b[31m${d}\x1b[0m`);
      }
    }
  }
  console.log(`\n${pass} match vim, ${fail} differ`);
  return fail ? 1 : 0;
}

process.exit(main());
