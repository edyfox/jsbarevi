# ALIGNMENT — how we stay close to busybox, and how we check

The count-before-insert feature (`10atest<Esc>`) produced **five** bugs, and only
one of them was about counts. The rest were places where we had re-derived
something busybox had already settled:

| Bug | What busybox already does |
|---|---|
| leaving insert at column 1 jumped a line | `dot_left()` refuses to step back over a newline |
| `a` on an empty line typed on the next line | `dot_right()` refuses to step over a newline |
| `X` at column 1 joined two lines | same `dot_left()` rule |
| `2o<Esc>` produced one blank line, not two | count handling in `dc_o` |
| the cursor could rest on a newline | the `dot--` normalisation at the tail of `do_cmd()` |

So the rule is not "the feature list matches busybox". It is:

> **Adopt the primitive. If busybox has no primitive, adopt the invariant. Never
> re-derive a rule from intuition at a call site.**

## Structural alignment: the primitives

`src/engine/cursor.js` ports them, with busybox's exact guards
(`editors/vi.c:1811-1867`):

| busybox | guard | ours | used by |
|---|---|---|---|
| `dot_left` | `if (dot > text && dot[-1] != '\n') dot--` | `left()` | `h`, leaving insert, `X` |
| `dot_right` | `if (dot < end-1 && *dot != '\n') dot++` | `right()` | `l`, `a` |
| `dot_begin` | `dot = begin_line(dot)` | `beginLine()` | `0`, `I` |
| `dot_end` | `dot = end_line(dot)` | `endLine()` | `$`, `A` |
| `dot_next`/`dot_prev` | `next_line`/`prev_line` | `nextLine()`/`prevLine()` | `j`/`k` line targets |
| `dot_skip_over_ws` | skip blanks, never the newline | `skipBlank()` | `^` |
| end-of-command `dot--` | `if (*dot=='\n' && cnt>0 && cmd_mode==0)` | `Engine._stayOffNewline()` | every dispatch |

**The asymmetry is the subtle part and is deliberate:** `right` may land on a
newline (that is why `l` at end-of-line works at all — the end-of-command
normalisation pulls it back), while `left` never crosses one. `test/cursor.mjs`
asserts both directions, including the three historical bugs.

## Behavioural alignment: the generated matrix

Hand-written cases kept missing the gaps (empty line, column 1, last column).
`npm run audit:align` generates the matrix instead: **every combination of**

- 9 buffer shapes: empty, one empty line, one line, two lines, blank line in the
  middle, indented, words, brackets, last line without a trailing newline
- 6 cursor positions: 1:1, 1:last, 2:1, 2:last, last:1, middle
- 46 commands that touch a boundary, a count, or a cursor placement

= **2,430 combinations, each run through real vim and through the engine**.

### What it found, in order of size

| Class | Example | Busybox settled it by | Status |
|---|---|---|---|
| `>`/`<` on blank lines | `>>` indented an empty line | skipping blank lines | fixed |
| `>`/`<` with a motion that cannot move | `j>j` on a one-line buffer shifted it | operator cancelled on a failed motion | fixed |
| `cw` semantics | `cw` at the end of a word ate the rest of the line | `find_range()` special-cases `c`+`w` | fixed |
| `dw` and the line break | `dw` on the last word took the newline | `find_range()` steps back off the newline | fixed |
| `e` across lines | `e` at a word end did not advance | word search crosses lines | fixed |
| `r` with nothing to replace | `rq` inserted into an empty buffer | range check before replace | fixed |
| `X` at column 1 | joined two lines | `dot_left()` | fixed |
| `>`/`<` cursor when nothing changed | `<` on an unindented line moved the cursor | cursor untouched when the line is unchanged | fixed |

Progress: **478 → 100 → 78 → 70** differing combinations out of 2,430 (85% of the
discovered misalignment closed in one pass). Run `npm run audit:align` for the
current figure; anything it reports belongs in `oracle/cases/` before it is fixed,
so it cannot come back.

### Backlog: the 70 that remain

| Command | Combos | What differs |
|---|---|---|
| `db` | 7 | word-back across a blank line or from the first word of a line: vim stops at the line/blank boundary, we skip to the previous word |
| `yyP` | 6 | pasting above on a blank/empty buffer: vim ends with one more empty line than we do |
| `OZ<Esc>` | 6 | same, for an insert opened above |
| `3iZ<Esc>` | 6 | count + insert on the blank/empty shapes |
| `J` / `2J` | 10 | joining when the neighbour is a blank line |
| `cwZ<Esc>` / `de` / `d$` | 13 | word/line-end spans on the indented shape |
| `w` / `k` / `~` | 9 | remaining single-case differences |
| others | 13 | see the audit output |

None of these are new classes: they are the same boundary rules applied to shapes
the hand-written cases never used (blank line in the middle, indented first line,
last line without a trailing newline). The audit lists the exact
(shape, position, keys) for each, so they are cheap to turn into cases.

## What this means for the plan

Busybox was right to drop count-before-insert: it costs a handful of interaction
rules to support, and each rule is a corner case. We keep it because the host owns
insert mode here, which makes the *capture* cheap — but the lesson stands:

- For anything busybox supports: read its code first, adopt the primitive.
- For anything it drops: assume the corner cases are real and budget for them.
- For the Vim-only extensions (visual mode, text objects): the matrix still runs,
  but there is no busybox to lean on — those stay the highest-risk area, which is
  why they carry the densest case files.
