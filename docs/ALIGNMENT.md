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

### The buffer always ends in one newline

`busybox` makes this explicit — it appends the newline a file is missing, with the
reason in the comment (`editors/vi.c:2320`):

```c
	if (rc <= 0 || *(end - 1) != '\n') {
		// file doesn't exist or doesn't end in a newline.
		// insert a newline to the end
		char_insert(end, '\n', NO_UNDO);
	}
```

It has to: `dot_right()` bounds itself with `end - 1`, `at_eof()` tests
`*(end - 2)`, and the end-of-command `dot--` only fires when `*dot == '\n'`. vim
gets the same property from a different place — its buffer is a *list of lines*,
so the newline after the last line exists whether or not the file ends with one.
We adopt it because without it three whole families of state are unrepresentable:

- **the empty buffer** — one empty line, not zero lines;
- **an empty last line** — `jD` on a last line with no EOL leaves `["abc", ""]`,
  and "delete the last line's text" must not shorten the buffer by a line;
- **end-of-buffer insert** — `A` at the very end has nowhere to stand.

`src/engine/engine.js` enforces it in exactly one place, `_setText()`, and
`hostText` is the documented view the field gets (`text` minus the terminator).
Before this landed, the audit's 70 remaining cases looked like 17 unrelated
command bugs; they were 39 instances of this one missing invariant plus six real
rule gaps.

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

Progress: **478 → 100 → 78 → 70 → 0** differing combinations out of 2,430. Run
`npm run audit:align` for the current figure (add `-- --all` to list every case
rather than the first four per command, or `-- <substring>` to audit one command);
anything it reports belongs in `oracle/cases/` before it is fixed, so it cannot
come back.

### The backlog that was: 70 → 0, and what it actually was

The 70 were reported as 17 command rows, but they were **two** things:

**39 combinations were one missing invariant** — the trailing buffer newline
above. `yyP`/`OZ`/`3iZ` on the empty buffer, `D`/`dw`/`de`/`d$`/`cw`/`cc`/`A`
on a last line without an EOL, and the `k`/`db` cases on those same shapes all
went green from that single change.

**31 combinations were six real rule gaps**, each measured against vim before
being implemented (all pinned in `oracle/cases/alignment.json`):

| Rule | Combos | What vim actually does |
|---|---|---|
| `J` against a blank neighbour | 10 | a blank line is removed outright, **no space**; and no space when the line joined *into* is blank |
| `w` / `b` stop at an empty line | 4 | an empty line counts as a word |
| `db` is exclusive-linewise | 7 | a charwise motion starting on a line's first non-blank and ending on a line boundary becomes **linewise**; otherwise the end steps back off the newline |
| `de` / `d$` / `cw` on an empty line | 6 | `de` takes whole lines when it covers a line's tail, `d$` is a **no-op**, `cw` inserts **without deleting** |
| curswant after `$` | 3 | `$` sets the vertical wish to MAXCOL, so `j`/`k` land on the last character of any line |
| `~` on a non-letter | 3 | `~` **advances** even when the character cannot be flipped (busybox's `dot_right()` in a loop) |

Two derived lessons, both already in the working rule:

- **A count is a claim until you measure it.** "17 commands differ" was a
  description of the *symptom*; the first question that paid was "how many of
  these share a cause?", and it collapsed 70 → 39 without touching a command.
- **A comparison harness can hide a model bug.** The audit normalised *both*
  sides, so an engine that could not represent an empty last line still looked
  like it was merely "one column off" in a dozen commands.

## What this means for the plan

Busybox was right to drop count-before-insert: it costs a handful of interaction
rules to support, and each rule is a corner case. We keep it because the host owns
insert mode here, which makes the *capture* cheap — but the lesson stands:

- For anything busybox supports: read its code first, adopt the primitive.
- For anything it drops: assume the corner cases are real and budget for them.
- For the Vim-only extensions (visual mode, text objects): the matrix still runs,
  but there is no busybox to lean on — those stay the highest-risk area, which is
  why they carry the densest case files.

The matrix is now **clean**, which changes the meaning of a red: it is a
regression, not a known gap. That is what makes it worth running before every
release of the engine.
