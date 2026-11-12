#!/usr/bin/env node
// Behavioural audit: does the engine actually dispatch every command on the
// frozen surface? A command counts as missing when feeding it leaves the engine's
// status saying "unmapped", or throws.
//
// This is a smoke test, not a semantics test: semantics are covered by the oracle
// cases and the differential run.

import fs from "node:fs";
import path from "node:path";
import { Engine } from "../src/engine/engine.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const rows = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/target-surface.json"), "utf8"));

// What to feed for a command that needs an argument.
const ARG = {
  f: "x", F: "x", t: "x", T: "x", r: "x",
  m: "a", "'": "a", "`": "a", '"': "a",
  z: "t", g: "g",
};

// The engine's key API takes "C-x" for control keys (the adapter's tokenizer
// produces those); "<count>" is a pseudo-command, not a key.
// raw is the actual character for control keys (0x08 for ^H), not the two-char
// spelling, so map by code point.
const asKey = (raw) => (raw.length === 1 && raw.charCodeAt(0) < 32
  ? "C-" + String.fromCharCode(raw.charCodeAt(0) + 96)
  : raw);

const results = [];
for (const row of rows) {
  if (row.key === "<count>") { results.push({ ...row, ok: true }); continue; }
  const engine = new Engine({ viewport: () => ({ top: 0, height: 4 }) });
  engine.setText("foo(x) bar\nsecond line\nthird\n", 0);
  const key = asKey(row.raw);
  const seq = (ARG[row.key] !== undefined ? key + ARG[row.key] : key);
  if (process.env.TRACE) process.stderr.write(`  ${row.key} ... `);
  let threw = null;
  try {
    for (const ch of seq) engine.feed(ch);
  } catch (err) {
    threw = err.message;
  }
  if (process.env.TRACE) process.stderr.write("done\n");
  const unmapped = engine.status.some((s) => /unmapped|not a motion|no text object/.test(s));
  results.push({ ...row, ok: !threw && !unmapped, why: threw || (unmapped ? "unmapped" : "") });
}

const missing = results.filter((r) => !r.ok);
console.log(`surface: ${results.length} commands`);
console.log(`dispatched: ${results.length - missing.length}`);
console.log(`missing: ${missing.length}`);
for (const m of missing) console.log(`  - ${m.key}  (${m.family})  ${m.why}`);
process.exit(missing.length ? 1 : 0);
