# DECISIONS — the frozen surface

Status: **frozen 2026-11-12.** Additions must displace something; the point of
freezing is that the engine gets written instead of the spec growing.

## The rule that decides everything

**Cost decides, not personal taste.** A feature that a reference implementation
does simply is cheap enough to carry, even if nobody uses it daily. The original
cut list was about keeping the implementation small, never about preference.

A command may only be excluded for one of three reasons:

1. **No ex mode** — `Q`, `\`. (`:` stays: it is one-shot, and the escape hatch
   rides it.)
2. **No referent in a single text field** — screen geometry and file lifecycle
   belong to the host: `Z`, `^L`, `^R`, `^Z`, `^W`, `^T`, `^]`.
3. **Needs an external process** — `!` (shell), `K` (keyword program).

## The surface: 88 vi-mode commands

| Family | Commands |
|---|---|
| Motions, characters/lines | `h l j k ^H ^J ^N ^P <space> + - _ ^M 0 $ ^ \|` |
| Motions, screen lines | `gj gk g0 g$ g^` — see the note below |
| Motions, words | `w b e W B E` |
| Motions, paragraphs/sentences | `{ } ( )` |
| Jumps and search | `f F t T ; , % / ? n N * # G gg` |
| Increment/decrement | `^A` `^X` — with counts, and `.` repeats |
| Turn off in one field | `:q` — hand the field back to the browser until it is refocused (see README) |
| Marks | `m ' `` ` `` |
| Viewport | `H M L z ^B ^D ^E ^F ^U ^Y ^G` |
| Insert entry | `i a I A o O R` |
| Delete/change/yank | `d c y x X s S D C Y r` |
| Put | `p P` |
| Repeat/undo | `.` `u` `U` |
| Join/case/indent | `J ~ < >` |
| Visual | `v` `V` (no block visual) |
| Registers | `"` `_` `+` `*` (and `"a`-`"z`, `"A`-`"Z`) |
| Ex mode | `:` |

Explicitly **out**: `[ ]` (C sections — no referent), `^V` (block visual),
`@`/`q` (macros — a replay loop plus register recording, and it would have to own
insert mode to replay typing), `"0`-`"9` and `"-` (see below), `.` (the
last-inserted-text register), `!` `=` `&` `K` `` `^A ``-style nvi extras with no
counterpart (the `=` *command* that prints a line number, not the `=` register),
`Q` `\` (ex mode).

### Registers: the set, and the set we refused

The reason to have registers at all is the system clipboard: without `"+` there is no
way to get text out of a browser field into the rest of the machine, and making the
clipboard the *default* would put every `x` and every word of a `cw` on the system
clipboard. So the unnamed register stays in-engine, and `"+` is the explicit door.

| In | Why |
|---|---|
| `""` | what `p` reads; every yank and delete writes it |
| `"a`-`"z` | one character, one store — a line of code each |
| `"A`-`"Z` | the append form. Not useful, but leaving it out is a **silent wrong**: `"Ayy` would quietly create a second register named `A` rather than appending. One rule covers it (linewise if either side is) |
| `"_` | the black hole. Writes go nowhere, including to `""` — that is the whole point |
| `"+` `"*` | the system clipboard. One clipboard, two spellings: `*` is vim's X11 primary selection, which a browser does not have, so aliasing is the only honest option |
| `<C-r>{register}` | insert-mode insertion. Vim's fastest route from the clipboard into a field, and the one case where a Ctrl key is fatal to leave unconsumed: browser Ctrl-R reloads the page. The engine decides the text; the adapter inserts it, because insert mode belongs to the host |

| Out | Why not |
|---|---|
| `"0`, `"1`-`"9`, `"-` | Not one rule but three that interact: they rotate on a linewise or multi-line delete, hold *small* deletes back in `"-` instead, and rotate anyway when that small delete was given a named register (`"adw` fills `"a` and leaves `"-` alone, while `dd` fills `"1` and leaves `"-`). Measured against vim 9.2 and written into `docs/ENGINE.md`; the rotation exists so you can walk back through a session's deletes, which is not what this editor is for, and the small/big split needs a per-operation classification nothing else in the engine has |
| `.` (last insert) | A whole second recording surface for one case: "repeat the text I typed, not the command". `.` already replays the *command* by diffing a snapshot (`docs/DECISIONS.md` above), and this register would not improve that — it would only add a second, subtly different answer |
| `q`/`@` (macros) | A replay loop, plus key recording that has to capture insert-mode typing — which belongs to the host, so the recording would be a reconstruction, not a recording. Every failure in this area is a silently wrong buffer |
| `"=` (expression) | It needs `eval`. In the hosts that matter — a page world like Lark's, an Electron `oc://` page — the **page's CSP refuses it**, so the feature would work in Chrome and fail silently in the others. The same code in every host, or it is not in. (Measured, not assumed: the failure appears in the field's own status line.) |

Scope rule this follows: a register goes in when it is one rule; it stays out when it is
a state machine (numbered), a second recording surface (`.`), a replay engine (`@`), or a
capability the host may refuse (`=`).

### Where we are approximate, and say so

Nothing in the register or motion surface is knowingly approximate any more: the three
divergences found on 2026-11-14 (`U`'s cursor column, `C-e`/`C-y` and the cursor, and `d}`
at the end of the buffer) were measured and fixed — see "Divergences: closed" in
`docs/ENGINE.md`. The approximations that remain are the old, documented ones about `.`
replaying an insert by diffing a snapshot, and the viewport commands needing a host that
can report a viewport.


### Notable inclusions, and why

- **Marks and registers** are in because busybox implements them in ~20 lines
  each (`mark[26]`, `char *reg[28]`), and the registers stay **in-engine** — the
  browser's clipboard is async and permission-gated, so `p` must not wait on it.
  The system clipboard is a host *capability* behind a cache rather than a register
  the engine owns; see "Registers" in `docs/ENGINE.md` for the set, the reason for
  each, and the ones that were measured and refused.
- **`. ` repeat, `U`, `R`** are in because both references have them. `.` is the
  highest-value single addition and the hardest: insert mode belongs to the host,
  so the typed text is captured by diffing snapshots, not by recording keys.
- **Text objects** (`iw aw i" a( a{` …) are in even though *neither* reference has
  them: they are Vim lineage, already implemented, and `ciw` is most of what makes
  insert-mode editing usable.
- **Viewport commands** are in because one adapter capability unlocks ten of
  them. They are inert on a host that cannot report a viewport.
- **Insert-mode `C-w` / `C-u`** are in as an explicit, narrow exception to busybox
  parity (2026-11-15): busybox has neither, but the browser's own answers to those keys
  are close-tab and view-source, and the hand reaches for them without thinking. The
  exception is capped — no `'backspace'` option, no line join, and a written refusal list
  for the twelve neighbouring keys (see the section above).
- **`^G`** is in by the rule, against Edward's own preference, reporting
  `[Modified] line N of M · col C · K chars`.

### Screen-line motions, and why they are not scope creep

`gj gk g0 g$` were added on 2026-11-13, after the freeze, and the displacement
argument is the host's own behaviour: a browser caret moves by **screen** line
(`<Up>`, `<Down>`, `Home`, `End` all wrap-aware in insert mode), and vim's arrows
are screen-line motions too when `'wrap'` is set. Without them, normal mode could
not be consistent with insert mode in the same field — the caret would jump to a
different place depending on which mode you were in. They are gated on a `metrics`
capability and degrade to `j k 0 $` without it, which is the same shape as the
viewport commands.

What they displace: `gm`, `gM`, `g'`, `gE`, `g_` are **not** added. One family — row
start, row end, one row up, one row down, first non-blank — is what a text field
actually needs. (`g^` joined them on 2026-11-13, because with `'wrap'` off it is the
only way to reach the first non-blank of the *visible* window, which is a real place in a
horizontally scrolling field.)

## Insert-mode `C-w` / `C-u`: beyond baseline, no option, one corner broken on purpose

Added 2026-11-15, after the freeze, for two reasons that are not taste:

1. **In a browser field the browser's own answer to both keys is destructive** —
   Ctrl-W closes the tab, Ctrl-U is view-source — so an editor that leaves them alone is
   an editor you lose work in.
2. **Frequency beats baseline parity.** Measured (`oracle/cases/insert-backspace-refs.json`):
   **busybox does not implement either command at all** — it inserts the raw control byte
   into the buffer, which is worse than doing nothing — while **nvi** implements both with
   classic vi semantics (it deletes only what the insert typed, and never joins a line).
   So this is a **beyond-baseline, Vim-lineage** command like text objects and marks.

### The scope rule, stated once (Edward, 2026-11-15)

Three priorities, in this order, for any beyond-baseline command:

1. **Muscle memory wins.** An operation done without thinking must land exactly as the
   tool the hand already knows. This is not negotiable and not a place to be creative:
   "delete what I just typed with Ctrl-W" has to behave like vim, or the feature is worse
   than absent.
2. **A corner is kept when it falls out of the same primitive.** If faithful behaviour
   costs no new rule - it is the same word scan, the same wall, the same deletion - keep
   it. Cheapest examples here: C-w *inside a pre-existing word* (both "delete the typed
   insertion only" and "delete back to the word start when nothing was typed") came out of
   `wordBack` plus the insert-start wall with **zero** case-specific code.
3. **Otherwise the gap is documented and the corner dropped.** Not silently, not
   "approximately": written down in `docs/ENGINE.md` with the mechanism that would be
   needed, so it is a decision and not folklore.

A useful calibration from outside this repo: **VsVim** - a famous Vim emulator, written by
Microsoft engineers - does not handle the pre-existing-word case correctly. That is the
class of corner where "faithful if free, dropped if not" is the right policy, because even
a well-funded emulator with a large team leaves it behind.

Scope is capped on purpose, following that rule (2026-11-15): *implement it, do not chase completeness
— most people use a few happy paths, and the corners are not worth their code.* The
concrete consequences, all recorded in `docs/ENGINE.md`:

- **No `'backspace'` option.** The first draft had one — vim's flag string `indent,eol,start`,
  plus its obsolete numeric form — because that is how vim expresses this. Removed. An
  option does not add a case to the test matrix, it **multiplies** it; three flags over two
  commands over the caret and replace-mode variants is a matrix nobody keeps running, and
  the third option in a codebase is where the suite stops being convincing. The behaviour
  is fixed instead: typed text and the word before the insert start are deletable, a line
  break never is.
- **The line join at column 1 is deliberately not implemented.** vim deletes the break and
  joins the lines there; here the key is consumed and the text is untouched. Supporting it
  needs three interacting states (`eol`, `start`, and whether the break was typed by this
  insert or already existed) for a corner that is rarely intended, and an accidental join
  in a message composer merges two sentences.
- **What survives is the happy path plus the walls that make it safe**: the insert start is
  a wall once text is typed (so a second C-w cannot reach into the document), the word
  before the insert start goes when nothing is typed (the case that makes the key useful,
  and the one nvi refuses), and whitespace travels with the word.

The one piece that looks like a corner but stays is **replace mode**: there the deletion
has to UN-type, restoring what the typed characters displaced, because a plain deletion
would leave the snapshot reconstruction re-inserting text the user deleted. It is ~10 lines
and shares its rule with the write path (`_replaceConsumed`), so it is not a second surface.

### One insert-mode command invited the other twelve, all refused

Adding `C-w`/`C-u` is how an insert-mode keymap starts. These are the neighbours a user
will ask for next, and each is refused for a reason that does not change when it is asked
again — busybox has none of them, so every one of them is a beyond-baseline addition that
has to earn its code:

| Refused | What vim does | Why not |
|---|---|---|
| `<C-o>` | run ONE normal-mode command, then return to insert | the biggest one, and the one people miss most. It is a temporary mode switch whose whole value is that the host's caret survives it — a state machine across two owners of the caret, for a command that normal mode already does one keystroke later |
| `<C-a>` | insert the text inserted last time | a second recording surface (the same reason `.`-as-a-register and `"0`-`"9` were refused), and `C-a` is already increment in normal mode |
| `<C-n>` / `<C-p>` | keyword completion | a completion engine: candidate sources, a menu, host-specific behaviour. Not a field editor's job |
| `<C-x>` submodes | completion, again | same |
| `<C-t>` / `<C-d>` | indent / dedent the current line | this engine never inserts an automatic indent, so there is no indent state to adjust; `>>`/`<<` in normal mode do it |
| `<C-e>` / `<C-y>` | copy the character below / above | needs a column model across lines plus wrap interaction — and both keys already mean scroll-lines in normal mode |
| `<C-v>` | insert the next key literally | the host already inserts what the host inserts; a literal-next mode would mean capturing keys we deliberately do not own |
| `<C-k>` | digraph | an input-method feature, and the OS/IME already owns it |

The rule that produces that table is the one above it: **busybox parity is the closed goal;
anything past it is a deliberate exception, and an exception needs a reason that survives
being written down.** One insert-mode command was worth an exception. Twelve are not.

## The `:` line: busybox parity## The `:` line: busybox parity

18 commands: `delete` `edit` `file` `features` `list` `quit` `next` `prev`
`read` `rewind` `set` `version` `write` `yank` `s` `x` `=` `!`, plus addresses
and ranges (numbers, `.`, `$`, `%`, `/pat/`, `?pat?`, `'x` marks, `,` `;`), a
count, and a `!` force suffix. **Prefix matching**, as busybox does (`:d`, `:e`,
`:w`, `:q`, `:se`).

Disposition in a browser field:

| Group | Commands |
|---|---|
| Implement | `s` `delete` `yank` `=` `list` `set` `version` `features` |
| Repoint at the external editor session | `e` `w` `wq` `q` `q!` `x` |
| Repoint at the same status line as `^G` | `file` |
| Refuse with a message (no referent) | `read` `next` `prev` `rewind` |
| Refuse (no shell — and it is the RCE we designed against) | `!` |

## `:set`

`autoindent` · `expandtab` · `err_method` (users see it as `flash`) ·
`ignorecase` · `showmatch`, each with a `no` prefix, plus numeric
`tabstop`/`ts`. This replaces a bespoke settings UI **and** persists.

## Escape hatch

`:e` launches a real editor on the buffer; `scratch-buffer.js` (fake vim inside
fake vim) is deleted. `:wq`/`:x` commit, `:q!`/`:cq` discard — free, because the
editor is real vim on a real temp file. Return path is **compare-and-swap**: if
the field changed while the editor was open, do not clobber it.

Transport is per host (decided 2026-11-12): native messaging on Chrome, a
main-process channel on OpenCode, WebSocket on Devin's sessions window, the
clipboard as a first-class path elsewhere, with the TextEditAid-compatible HTTP
protocol as an optional backend. A page-world payload cannot be handed a secret,
so `X-Edit-Token` only applies where a real extension origin exists; otherwise the
transport itself is the boundary.

Editor launch: `vim -N -u NONE -i NONE -n --cmd 'set nomodeline'` — `-N` is
mandatory (`-u NONE` alone is *compatible* mode), and `nomodeline` closes the
"opening the file is already execution" vector. Cursor opens via
`+call cursor(l,c)` (not `+l:c`, which is not vim syntax) and returns via a
`VimLeavePre` sidecar.

## Non-goals, permanently

- Vim script, plugins, autocommands, `:g`/`:v`, folds, tags, sessions.
- Block visual mode.
- Multi-cursor.
- Reimplementing the host's typing, IME, paste or undo.
- A settings popup (`:set` is the settings).
