// The alignment matrix: buffer shapes x cursor positions x commands.
//
// Extracted so the two audits (against vim, and the undo invariant) cannot drift
// apart. A matrix that lives in two files is a matrix that is only right in one
// of them.
export const SHAPES = {
  "empty": "",
  "one-empty-line": "\n",
  "one-line": "ab\n",
  "two-lines": "abc\ndef\n",
  "blank-middle": "a\n\nb\n",
  "indented": "  ab\ncd\n",
  "words": "one two three\nfour five\n",
  "brackets": "f(x) y\n[z]\n",
  "last-line-no-eol": "abc\ndef",
  // a trailing blank is a shape, not a detail: `J` only adds a separator when there
  // is none, and a space at a soft wrap hangs (see caret.js)
  "trailing-space": "ab \ncd\n",
};

// A short path to a starting position; "" means column 1 of line 1.
export const POSITIONS = {
  "1:1": "",
  "1:last": "$",
  "2:1": "j",
  "2:last": "j$",
  "last:1": "G",
  "mid": "ll",
};

// Commands that touch a boundary, a count, or a cursor placement rule. The
// insert-opening ones are here because their undo must cover the delete too
// (`s` + Esc + `u` was the bug that made the undo audit exist).
export const COMMANDS = [
  "x", "X", "D", "dd", "yy", "p", "P", "J", "~", "rq", "2x", "3~",
  "w", "b", "e", "dw", "de", "db", "d$", "d0",
  "cwZ<Esc>", "ccZ<Esc>", "yyP", ">j", "<j", "u", ".",
  "sZ<Esc>", "SZ<Esc>", "CZ<Esc>", "2sZ<Esc>", "RXY<Esc>",
  "iZ<Esc>", "aZ<Esc>", "IZ<Esc>", "AZ<Esc>", "oZ<Esc>", "OZ<Esc>", "3iZ<Esc>",
  "0", "^", "G", "gg", "h", "l", "j", "k",
  "2J", "r<Esc>", "%",
];

/** Every (input, keys) the audits share, filtered to the commands asked for. */
export function* combinations(commands = COMMANDS) {
  for (const [shape, input] of Object.entries(SHAPES)) {
    for (const [posName, pos] of Object.entries(POSITIONS)) {
      for (const cmd of commands) {
        yield { shape, posName, input, cmd, keys: pos + cmd };
      }
    }
  }
}

/** Parse `[--flag] [substring]` from argv without a dependency. */
export function parseArgs(argv = process.argv.slice(2)) {
  const flags = argv.filter((a) => a.startsWith("--"));
  const only = argv.find((a) => !a.startsWith("--"));
  return {
    flags,
    has: (name) => flags.includes(name),
    commandFilter: (all) => (only ? all.filter((c) => c.includes(only)) : all),
  };
}
