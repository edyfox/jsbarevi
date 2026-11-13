// Shared driver for anything that compares our engine with a real editor.
// Extracted from test/differential.mjs so the alignment audit can use the same
// measurement code instead of a second, subtly different copy.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine, Mode } from "../../src/engine/engine.js";
import { fromField } from "../../src/engine/buffer.js";

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

export const tokenize = (seq) => seq.match(/<[A-Za-z-]+>|[\s\S]/g) || [];
export const toVimKeys = (seq) => tokenize(seq).map((t) => VIM_TOKENS[t] ?? t).join("");

/** A buffer of one empty line is a newline on disk and "" here; compare the same. */
/** vim's file always ends with the newline vim itself keeps; our buffer always
 *  carries exactly one terminator (buffer.js), so stripping one from each side is
 *  lossless - an empty LAST line survives as a trailing "\n" on both. */
export const normalise = (t) => t.replace(/\n$/, "");

/** Run keystrokes in real vim; returns buffer, line and column (1-based). */
export function runVim(input, keys, { options = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jsbarevi-"));
  const file = path.join(dir, "buffer.txt");
  const pos = path.join(dir, "pos.txt");
  const script = path.join(dir, "s.ex");
  fs.writeFileSync(file, input);
  const pre = Object.entries(options)
    .map(([k, v]) => `set ${typeof v === "boolean" ? (v ? k : "no" + k) : `${k}=${v}`}`)
    .join("\n");
  fs.writeFileSync(script, [
    "set nomodeline",
    pre,
    "call cursor(1,1)",
    // feedkeys, NOT `execute "normal!"`: a beeping key inside :normal! aborts the
    // rest of the sequence (measured), silently truncating the case.
    `call feedkeys("${toVimKeys(keys).replace(/"/g, '\\"')}", "ntx")`,
    `call writefile([printf('%d:%d', line('.'), col('.'))], '${pos}')`,
    "wq!",
  ].join("\n") + "\n");
  execFileSync("vim", ["-N", "-u", "NONE", "-n", "-i", "NONE", "-es", "-S", script, file], {
    stdio: "ignore",
    timeout: 20000,
  });
  const [line, col] = fs.readFileSync(pos, "utf8").trim().split(":").map(Number);
  return { text: normalise(fs.readFileSync(file, "utf8")), line, col };
}

// The host's edit, exactly as the textarea adapter performs it: applyHostEdit, not
// setText, because replace mode has to drop what the browser overwrote.
function hostEdit(engine, nextText, nextCursor) {
  engine.applyHostEdit(fromField(nextText), nextCursor);
}

export function hostType(engine, key) {
  const t = engine.hostText;
  const c = Math.min(engine.cursor, t.length);
  if (key === "BS") { if (c > 0) hostEdit(engine, t.slice(0, c - 1) + t.slice(c), c - 1); return; }
  if (key === "CR") { hostEdit(engine, t.slice(0, c) + "\n" + t.slice(c), c + 1); return; }
  if (key === "Tab") { hostEdit(engine, t.slice(0, c) + "\t" + t.slice(c), c + 1); return; }
  if (key.length === 1) hostEdit(engine, t.slice(0, c) + key + t.slice(c), c + key.length);
}

/** Run the same keystrokes in our engine with a minimal host for insert mode. */
export function runOurs(input, keys, options = {}) {
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

/** Compare one case; returns a list of human-readable differences. */
export function compare(ours, vim, { noPosition = false } = {}) {
  const diffs = [];
  if (vim.text !== ours.text) diffs.push(`text ${JSON.stringify(ours.text)} != vim ${JSON.stringify(vim.text)}`);
  if (!noPosition && (vim.line !== ours.line || vim.col !== ours.col)) {
    diffs.push(`pos ${ours.line}:${ours.col} != vim ${vim.line}:${vim.col}`);
  }
  return diffs;
}
