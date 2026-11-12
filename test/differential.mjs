// Differential test: the same keystrokes into real `vim -N -u NONE` and into our
// engine, then compare buffer + cursor. No hardcoded expectations — vim is the
// reference at runtime, which is the whole point of the oracle work.
//
// Skips cases that need a prompt (search, `:`) because a prompt is a UI event,
// not a keystroke; those live in unit.mjs.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Engine, Mode } from "../src/engine/engine.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const TOKENS = {
  "<Esc>": "Esc", "<CR>": "CR", "<Tab>": "Tab", "<BS>": "BS",
  "<C-r>": "C-r", "<C-u>": "C-u", "<C-d>": "C-d", "<C-f>": "C-f", "<C-b>": "C-b",
  "<C-e>": "C-e", "<C-y>": "C-y", "<C-g>": "C-g", "<Space>": " ",
};
const VIM_TOKENS = {
  "<Esc>": "\\<Esc>", "<CR>": "\\<CR>", "<Tab>": "\\<Tab>", "<BS>": "\\<BS>",
  "<C-r>": "\\<C-R>", "<C-u>": "\\<C-U>", "<C-d>": "\\<C-D>", "<C-f>": "\\<C-F>",
  "<C-b>": "\\<C-B>", "<C-e>": "\\<C-E>", "<C-y>": "\\<C-Y>", "<C-g>": "\\<C-G>",
  "<Space>": " ",
};

function tokenize(seq) { return seq.match(/<[A-Za-z-]+>|[\s\S]/g) || []; }
function toVimKeys(seq) { return tokenize(seq).map((t) => VIM_TOKENS[t] ?? t).join(""); }

function runVim(input, keys) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jsbarevi-"));
  const file = path.join(dir, "buffer.txt");
  const pos = path.join(dir, "pos.txt");
  const script = path.join(dir, "s.ex");
  fs.writeFileSync(file, input);
  fs.writeFileSync(script, [
    "set nomodeline",
    "call cursor(1,1)",
    // feedkeys, NOT `execute "normal!"`: a failing key inside :normal! aborts
    // the rest of the sequence, silently truncating the case (measured).
    `call feedkeys("${toVimKeys(keys).replace(/"/g, '\\"')}", "ntx")`,
    `call writefile([printf('%d:%d', line('.'), col('.'))], '${pos}')`,
    "wq!",
  ].join("\n") + "\n");
  execFileSync("vim", ["-N", "-u", "NONE", "-n", "-i", "NONE", "-es", "-S", script, file], {
    stdio: "ignore", timeout: 20000,
  });
  const [line, col] = fs.readFileSync(pos, "utf8").trim().split(":").map(Number);
  let text = normalise(fs.readFileSync(file, "utf8"));
  return { text, line, col };
}

function hostType(engine, key) {
  const t = engine.text;
  const c = engine.cursor;
  if (key === "BS") { if (c > 0) engine.setText(t.slice(0, c - 1) + t.slice(c), c - 1); return; }
  if (key === "CR") { engine.setText(t.slice(0, c) + "\n" + t.slice(c), c + 1); return; }
  if (key === "Tab") { engine.setText(t.slice(0, c) + "\t" + t.slice(c), c + 1); return; }
  if (key.length === 1) engine.setText(t.slice(0, c) + key + t.slice(c), c + key.length);
}

// A buffer of exactly one empty line is "\n" on disk and "" in our model; treat
// both sides the same way so the comparison is about editing, not serialisation.
const normalise = (t) => (t === "\n" ? "" : t);

function runOurs(input, keys, options = {}) {
  const engine = new Engine({ options });
  engine.setText(input, 0);
  for (const tok of tokenize(keys)) {
    const key = TOKENS[tok] ?? tok;
    const r = engine.feed(key);
    if (!r.handled && engine.mode === Mode.INSERT) hostType(engine, key);
  }
  const before = engine.text.slice(0, engine.cursor);
  return {
    text: normalise(engine.text),
    line: before.split("\n").length,
    col: engine.cursor - (before.lastIndexOf("\n") + 1) + 1,
  };
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
      if (c.noDifferential) continue;
      if (c.engines && !c.engines.includes("vim")) continue;
      let vim;
      try { vim = runVim(c.input, c.keys); } catch (err) { console.log(`  \x1b[33mERR \x1b[0m ${c.name}: vim failed (${err.message})`); fail++; continue; }
      const ours = runOurs(c.input, c.keys, c.options || {});
      const diffs = [];
      if (vim.text !== ours.text) diffs.push(`text ${JSON.stringify(ours.text)} != vim ${JSON.stringify(vim.text)}`);
      if (!c.noPosition && (vim.line !== ours.line || vim.col !== ours.col)) {
        diffs.push(`pos ${ours.line}:${ours.col} != vim ${vim.line}:${vim.col}`);
      }
      if (!diffs.length) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${c.name}`); }
      else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${c.name}  keys=${JSON.stringify(c.keys)}`); for (const d of diffs) console.log(`       \x1b[31m${d}\x1b[0m`); }
    }
  }
  console.log(`\n${pass} match vim, ${fail} differ`);
  return fail ? 1 : 0;
}

process.exit(main());
