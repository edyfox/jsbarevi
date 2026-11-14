// Runs the SAME case files as the reference oracle (oracle/cases/*.json) through
// our engine, so "matches vim" is a measurement rather than a claim.
//
// The test simulates a minimal host: while the engine is in INSERT it lets the
// "host" type, exactly as a real adapter does.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Engine, Mode } from "../src/engine/engine.js";
// ONE definition of "the host types", shared with the differential driver: a second
// copy silently kept typing like plain insert after replace mode existed.
import { hostType, hostInsert, normalise } from "./lib/engine-driver.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const TOKENS = {
  "<Esc>": "Esc", "<CR>": "CR", "<Tab>": "Tab", "<BS>": "BS",
  "<C-r>": "C-r", "<C-w>": "C-w", "<C-u>": "C-u", "<C-d>": "C-d",
  "<C-f>": "C-f", "<C-b>": "C-b", "<C-e>": "C-e", "<C-y>": "C-y", "<C-a>": "C-a", "<C-x>": "C-x",
  "<C-g>": "C-g", "<Space>": " ",
};

const norm = (tok) => TOKENS[tok] ?? tok;

export function drive(engine, keys) {
  for (const tok of keys.match(/<[A-Za-z-]+>|[\s\S]/g) || []) {
    const key = norm(tok);
    const r = engine.feed(key);
    // `<C-r>{register}`: the host inserts what the engine chose.
    if (r.insertText != null) { hostInsert(engine, r.insertText); continue; }
    if (!r.handled && engine.mode === Mode.INSERT) hostType(engine, key);
    if (r.prompt) return { prompt: r.prompt };
  }
  return {};
}

function position(engine) {
  const t = engine.text;
  const before = t.slice(0, engine.cursor);
  const line = before.split("\n").length;
  const col = engine.cursor - (before.lastIndexOf("\n") + 1) + 1;
  return { line, col };
}

function runCase(c) {
  const engine = new Engine();
  engine.setText(c.input, 0);
  drive(engine, c.keys);
  const pos = position(engine);
  const bad = [];
  // normalise on BOTH sides, exactly as test/differential.mjs does: the case files hold
  // vim's file text while the buffer always ends with its terminator, and the two differ
  // for an EMPTY buffer ("" versus "\n") - which is how `dgg` deleting everything
  // looked like a failure of the engine rather than of the comparison.
  if (c.expect.text !== undefined && normalise(engine.text) !== normalise(c.expect.text)) {
    bad.push(`text ${JSON.stringify(normalise(engine.text))} != ${JSON.stringify(normalise(c.expect.text))}`);
  }
  if (c.expect.line !== undefined && pos.line !== c.expect.line) bad.push(`line ${pos.line} != ${c.expect.line}`);
  if (c.expect.col !== undefined && pos.col !== c.expect.col) bad.push(`col ${pos.col} != ${c.expect.col}`);
  return { ok: bad.length === 0, why: bad.join("; "), pos, text: normalise(engine.text) };
}

function main() {
  const files = process.argv.slice(2).length
    ? process.argv.slice(2)
    : fs.readdirSync(path.join(ROOT, "oracle/cases")).filter((f) => f.endsWith(".json")).map((f) => path.join(ROOT, "oracle/cases", f));

  let pass = 0;
  let fail = 0;
  for (const file of files) {
    const spec = JSON.parse(fs.readFileSync(file, "utf8"));
    console.log(`\n\x1b[1m${path.basename(file)}\x1b[0m`);
    for (const c of spec.cases) {
      if (c.engines && !c.engines.includes("vim")) continue; // vim sets the behaviour spec
      const expect = c.expect_by_engine?.vim ?? c.expect;
      if (!expect) continue;
      const r = runCase({ ...c, expect });
      const mark = r.ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
      console.log(`  ${mark} ${c.name}  keys=${JSON.stringify(c.keys)}  @${r.pos.line}:${r.pos.col}`);
      if (!r.ok) { console.log(`       \x1b[31m${r.why}\x1b[0m`); console.log(`       got text=${JSON.stringify(r.text)}`); fail++; }
      else pass++;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  return fail ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("run-engine-tests.mjs")) process.exit(main());
