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
| Jumps and search | `f F t T ; , % / ? n N * # ^A G gg` |
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

- **`U`'s cursor column.** The line is restored exactly (pinned against vim in
  `oracle/cases/sweep.json`), but vim records the column at the moment of the first change
  and we cannot reproduce it from our state; we keep the current column, clamped. The
  differential compares the buffer only for `U`.
- **`C-e` / `C-y` cannot move the cursor.** Vim moves the cursor down when scrolling would
  push it out of the window. The window belongs to the host, so the engine can only *ask*
  for a scroll (`onScroll`) and the adapter re-reads the viewport afterwards.


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

## The `:` line: busybox parity

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
