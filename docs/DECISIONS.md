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
| Registers | `"` |
| Ex mode | `:` |

Explicitly **out**: `[ ]` (C sections — no referent), `^V` (block visual),
`@` (macros — needs a replay loop), `!` `=` `&` `K` `` `^A ``-style nvi extras with
no counterpart, `Q` `\` (ex mode).

### Notable inclusions, and why

- **Marks and registers** are in because busybox implements them in ~20 lines
  each (`mark[26]`, `char *reg[28]`), and registers stay **in-engine** — the
  browser's system clipboard is async and permission-gated, so `p` must not wait
  on it.
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
