# Engine: patch Input Vim or rewrite it? (2026-11-12)

Question: is it cheaper to extend Input Vim's engine, or keep only its harness and
rewrite the engine, using busybox vi as the specification?

Method: read the sources. Counts below are `wc -l` on the fork at `e05e662`
(`_repos/vim-input`) and busybox at `4f986c0`.

## 1. Where the code actually lives

| Layer | Files | LOC |
|---|---|---|
| **Pure engine** (no DOM, no host) | `command-types` 105 · `key-parser` 413 · `vim-engine` 155 · `shared/text-utils` 231 · `shared/motion-resolver` 635 · `register` 55 | **1,594** |
| **Per-host command implementations** | `handlers/input-handler` 1,142 · `handlers/contenteditable-handler` 1,743 | **2,885** |
| **Harness** (DOM/events/host glue) | `event-interceptor` 916 · `overlay` 258 · `page-bridge` 195 · `cursor-controller` 182 · `focus-manager` 158 · `settings-manager` 88 · `main` 68 · `element-detector` 43 · `page-escape-blocker` 26 | 1,934 |
| **To be deleted anyway** | `scratch-buffer` | 219 |
| **Total** | | **6,632** |

Two facts fall out immediately:

1. The engine is **24 %** of the code. The host plumbing is **71 %**, and it encodes
   months of knowledge about six hosts — injection seams, closed shadow DOM,
   Monaco bridges, ProseMirror transactions, focus stealing, asar layout.
2. **Every command is implemented twice.** The same 17 handlers exist in both
   files — `_doMotion`, `_doOperatorMotion`, `_doOperatorTextObject`,
   `_doLineOperator`, `_doDeleteChar`, `_doReplaceChar`, `_doDeleteWordBack`,
   `_doPaste`, `_doVisualEnter`, `_doVisualLineEnter`, `_doVisualOperator`,
   `_doVisualPaste`, `_doInsertEnter`, `_doUndo`, `_doRedo`, `_doEscape`,
   `_doScrollJump`.

**That is the decisive number.** Patching costs 2× per feature. Our target adds
26 vi commands, `.` `U` `R`, marks, registers, `:s`, `:set`, the status line, plus
a rework of the motion model — each one written twice, in two different DOM
dialects, with two sets of tests.

Rewriting costs 1× per feature, because the engine emits **text edits** and the
adapter applies them.

## 2. The multi-line / bullet-list premise — checked, does not hold

Input Vim does *not* preserve rich structure. Its contenteditable model is also a
flat string:

```js
function getFlatText(el) {
  var blocks = _getBlocks(el);           // direct element children only
  return blocks.map(_blockText).join('\n');
}
function _blockText(block) {             // walks: text nodes + <br> only
  ... if (child.nodeType === 3) parts.push(child.textContent);
      else if (child.nodeName === 'BR') parts.push('\n');
```

Consequences, by reading:

- `_getBlocks()` looks at **direct children only**, so a `<ul>` is a single block.
- `_blockText()` emits `\n` only for `<br>`. An `<li>` is an element with no
  separator, so `<ul><li>a</li><li>b</li></ul>` flattens to **`ab`** — the two
  items are concatenated with nothing between them. No bullet markers anywhere.
- When `document.execCommand` fails, the mutation fallback is
  `el.textContent = text.substring(0, from) + …` (three sites:
  `deleteRange`, `insertTextAt`, `_doReplaceChar`) — which **destroys all markup**
  in the field, lists included.
- The only structural provision is a CKEditor-only bridge
  (`_isFrameworkEditor` → `classList.contains('ck-editor__editable')`) that posts
  seven actions (`insertText`, `deleteSelection`, `deleteBackward`,
  `insertParagraph`, `replaceAll`, `undo`, `redo`) through a DOM event.

So the current engine does not solve bullet lists — it flattens them, and can
destroy them. **Adopting busybox's single-string buffer loses nothing that
exists.** The premise was backwards.

The bridge *is* the right idea though, and it is the seed of the new adapter
contract: the host applies the edit; the engine never touches the DOM.

## 3. Why busybox is a good specification but a bad transliteration target

busybox's model is `char *text, *end, *dot` — one heap block, reallocated and
`memmove`d on every edit (`text_hole_delete`, `text_yank`). That is why the C code
is full of pointer bookkeeping: `save_dot`, `orig_dot`, dot adjustment after
undo, `mark[26]` as raw pointers into a buffer that may have moved.

In JS with immutable strings, all of that **evaporates**:

| busybox (C) | Ours (JS) |
|---|---|
| `dot` pointer into a realloc'd buffer | integer offset into a string |
| `text_hole_delete` memmove | `s.slice(0,a) + s.slice(b)` |
| `mark[26]` pointers + `text <= q && q < end` guard | validated offsets (same guard, no UB) |
| undo via char-level buffer | an op log of edits (which `.` repeat wants anyway) |
| `begin_line/end_line/next_line` pointer walks | same arithmetic on indices |

So port the **algorithms** — line arithmetic, `yank_delete` range semantics,
`find_range`'s motion dispatch table, dot-command recording — and drop the
memory management. The faithful-but-simpler port is roughly **1,300–1,500 LOC**.

## 4. Verdict

**Rewrite the engine. Keep the harness. Reuse the adapters' mapping primitives.**

| | What |
|---|---|
| **Write new** (~1,400) | engine: modes, key parser (counts/operators/pending char arg), buffer-line motions, operators, text objects, visual, marks, registers, `.` `U` `R`, search, the `:` line, status line |
| **Keep, unchanged** (~1,900) | `event-interceptor` (prompts, cmdline, IME and Esc handling), `overlay`, `cursor-controller`, `focus-manager`, `element-detector`, `page-bridge`, `settings-manager`, `main` |
| **Keep, re-point at the interface** (~700) | `input-handler` → ~250-line `InputAdapter`; `contenteditable-handler` → ~450-line `DomAdapter` (its block/offset/selection machinery is the valuable part; the 17 command methods go) |
| **Reuse as-is** (~1,100) | `vscode-input-vim.js`, `chat-webview-input-vim.js`, `prosemirror-input-vim.js` — already in the "logical snapshot → commit a transaction" shape |
| **Delete** (~3,100) | `scratch-buffer`, and the per-command implementations in both handlers, which the engine now owns once |

Net: roughly **5.4k LOC replacing 6.6k**, with one implementation per command
instead of two, and every behaviour traceable to an oracle case.

## 5. One thing neither IV nor busybox has, and we should add now

The honest answer to the underlying worry: structure *does* matter in a browser
field, but it cannot be solved in a string. It has to be part of the **adapter
contract**, because only the adapter can see `<li>` vs `<p>` vs a mention atom.

```
adapter.getBuffer() -> {
  text:   "a\nb\nc",                 // the flat model the engine works on
  lines:  [{kind:'paragraph'},       // per-line metadata the engine carries
           {kind:'list-item', marker:'•'},
           {kind:'code'}],
  cursor: {line, col}
}
```

The engine stays string-based (busybox-faithful); the structure rides alongside
as a side array. Then `o` on a list-item line can create a *new item* rather than
a plain newline, `I` can skip the rendered marker, and `^`/`0` can be
marker-aware — all without the engine learning about DOM.

Adding this now costs one field in an interface. Retrofitting it after the
adapters are written means touching every motion and every command again.

## 6. Execution: strangler, not big-bang

1. Oracle harness first (real `vim -u NONE`, `/usr/bin/nvi`, `/usr/bin/busybox vi`).
2. New engine, developed and tested headless against the oracle — no host needed.
3. New adapter interface; port `InputAdapter`, then `DomAdapter`, reusing the
   existing mapping primitives.
4. Ship the new payload to **one** host (VS Code or Lark), keep the six currently
   patched hosts on the upstream payload until each new host passes the oracle
   and a human check. Two engines never run in the same host at once.
5. Retire the upstream payload when the sweep is green on all six.

Nothing about this depends on the upstream author, and the fork becomes a
read-only reference rather than a dependency.

---

# Review 2026-11-12 (Opus 5.5) — corrections that landed

Full report: `REVIEW-opus-2026-11-12.md`. Below, only what changed the documents,
split by whether **I re-verified it myself** (evidence) or am carrying it as a
**lead** to be re-checked when the code exists.

## Verified myself

| # | Correction | Evidence |
|---|---|---|
| 1 | **`G`, `gg` and `r` had no rows** in the matrix at all, although all three are in busybox and Input Vim. The "exhaustive" table was missing three commands. | re-deriving the family lists: `IN busybox but NOT in FAMILIES: G g r` (plus host/out-of-scope keys). Fixed in `build_matrix.py`; the target is now **88**, not 85. |
| 2 | **"76 active keys" was wrong twice over**: 76 counts char literals only (it includes the nine digits as nine separate keys) and drops the 13 numeric control-key cases. And the stub count is 33, not 18. | counted from `editors/vi.c`: 76 char-literal + 13 numeric active; 18 commented char + 15 commented numeric. Real surface ≈ 78–80. Doc corrected. |
| 3 | **`:set` has more than five options**: the boolean `err_method` is displayed to users as **`flash`**, and there is a numeric **`tabstop`/`ts`**. | `editors/vi.c:3163-3200`. |
| 4 | **`:s` takes line ranges**, so "limited to the current line" described the *pattern* scope, not the command scope — misleading as written. | `:%s` operates over a range; per-line matching via `char_search(..., LIMITED)`. Doc reworded. |
| 5 | **Input Vim has no IME/composition handling at all** — not even a guard. My "keep the IME gate" was false: we are *adding* it. | `grep -r composition content/` returns nothing. |
| 6 | **The three webview adapters cannot be reused as-is**: each one constructs `InputHandler`/`VimEngine`, i.e. exactly the code the rewrite deletes. Their snapshot→execute→diff→commit *pattern* is what we keep. | `grep -l "InputHandler\|VimEngine"` matches all three. |
| 7 | **`vim -u NONE` starts in *compatible* mode** — the daemon launch line was wrong. | `vim -u NONE -es -c 'set compatible?'` → `compatible`; with `-N` → `nocompatible`. |
| 8 | **`+{line}:{col}` is not valid vim syntax** — it parks the cursor at EOF. Correct form: `+call cursor(l,c)`. | `vim -es '+12:7' …` on a 4-line file left the cursor at `4:1`. |
| 9 | **`^R` is redo in Input Vim**; busybox has no redo. Leaving `^R` "to the host" reloads the page in a Chrome tab and loses the prompt. | `event-interceptor.js` binds `Ctrl+R` → `CommandType.REDO`. |

Also: the reviewer's running of the three editors agrees with the doc that
**`d/foo` works** (motion through `find_range`) and that `^F`/`^B` are absent.

## Carried as leads (re-check during implementation)

- busybox `:s` with a **range** (`:%s/o/0/g`) applies to every line; `&` in the
  replacement is **literal** in busybox but expanded in vim/nvi; `g` reads only
  its first flag character.
- **POSIX vs JS regex**: `\(o\|on\)` → `Xe` in busybox vs `Xne` in vim (JS matches
  vim); JS `RegExp` silently fails on `[[:space:]]`. Document, don't diverge
  silently.
- **Chrome**: a *content-script* fetch carries the page Origin (only a
  service-worker fetch carries `chrome-extension://`), and a service worker whose
  `fetch()` has not resolved in ~30 s is terminated.
- **Electron CSP**: loopback fetches are blocked in VS Code chat, the Cursor Agent
  window and Devin's sessions window (which permits `ws:`).

## Plan changes accepted

1. **`:e` transport is re-opened as a decision** (the biggest item). Candidate
   split: native messaging (Chrome) · main-process channel (OpenCode) ·
   WebSocket (Devin sessions) · clipboard as a *first-class* path elsewhere.
2. **`.` after insert commands is the top risk.** Insert mode belongs to the
   host, so the engine never sees typed text and cannot record keystrokes the way
   busybox does. Cheapest correct approach: diff the snapshot taken at insert
   entry against the one at Esc, accept only a single contiguous change.
3. **Add an "oracle of record" column.** busybox decides *scope* (what exists);
   `vim -N` with pinned options decides *behaviour*. The three editors genuinely
   disagree on `u` (toggle vs multi-level), and each host groups undo differently
   — the Claude adapter refuses `u` outright.
4. **Per-line metadata is necessary but not sufficient**: it cannot express nested
   lists, mentions/atoms or hard breaks, and there is no way for an adapter to
   *reject* an edit. It needs (a) an indent/level field, and (b) a veto: the
   adapter may refuse an edit and the engine must fall back to native.
5. **`^R` must be ours** (redo), because the browser owns it destructively.
   Same review owed for every browser-reserved chord.
6. **The "2× per feature" argument was overstated.** It is 2× for the two DOM
   handlers (textarea vs contenteditable); the newer webview adapters already run
   the engine through a snapshot with no layout. The rewrite still wins, but on
   *single implementation of each command + one text-edit contract*, not on a 2×
   multiplier for every feature.

---

# What we take from busybox: invariants, not just commands

The `Esc`-crosses-the-line-boundary bug (2026-11-12) has a root cause worth
recording, because it is not "we forgot a case".

busybox ends **every** command with the same normalisation (`editors/vi.c`, tail
of `do_cmd()`):

```c
cmdcnt = 0;
cnt = dot - begin_line(dot);
// Try to stay off of the Newline
if (*dot == '\n' && cnt > 0 && cmd_mode == 0)
    dot--;
```

That is an *invariant*: after any command the cursor never rests on a newline
(except at column 1 of an empty line, and never in insert mode). Because it is
central, no individual command can break it — including commands added later.

Our engine had no such invariant. Every command placed the cursor itself, so
"do not land on a newline" was an obligation repeated per command, and the one
path we hand-wrote from scratch — leaving insert mode, which we had to write
ourselves because the host owns insert while busybox owns it — dropped it.

The lesson generalises: when the reference implementation centralises a rule,
adopt the **rule**, not just the commands it produces. `_stayOffNewline()` now
runs after every dispatch, mirroring busybox.

A second, separate reason it survived: our differential tests compare buffers and
whole-number positions, so a one-column drift at a boundary is invisible in them.
That is why the boundary matrix (empty line, first/last column, empty buffer,
single-character buffer) is worth generating rather than waiting for a report.

## The second invariant: the buffer always ends in one newline

Same shape of bug, found by the alignment audit on 2026-11-13, and again a rule
the reference centralises rather than a case we forgot.

busybox appends the newline a file is missing, with the reason in the comment
(`editors/vi.c:2320`):

```c
	if (rc <= 0 || *(end - 1) != '\n') {
		// file doesn't exist or doesn't end in a newline.
		// insert a newline to the end
		char_insert(end, '\n', NO_UNDO);
	}
```

It has to. `dot_right()` bounds itself with `end - 1`, `at_eof()` tests
`*(end - 2)`, and the tail-of-`do_cmd()` normalisation above only fires when
`*dot == '\n'` — so without a terminating newline, the previous section's
invariant has nothing to fire on for the last line. vim arrives at the same
property from the other end: its buffer is a list of lines, so the newline after
the last line exists whether or not the file ended with one. Both references
agree on the observable behaviour; measured: `jD` on a file `abc\ndef` with no
EOL leaves `["abc", ""]` in vim **and** in busybox.

We adopted it after learning what its absence costs. Three states are simply not
representable without it:

- the empty buffer (one empty line, which `yyP`/`OZ` need);
- an empty **last** line (deleting the last line's text must not shorten the
  buffer by a line, or the last line's newline is taken as well);
- insert at the very end of the buffer (`A` there has nowhere to stand, and
  leaving insert then steps one character too far left).

The audit reported those as 39 of 70 differences spread over 17 commands. They
were one cause. `_setText()` is now the single writer for the buffer (every
mutation in the engine and in `ex.js` goes through it), `hostText` is the view
the field and `:e` transport get, and `lineCount()`/`lineEnd()` can keep their
"a trailing newline terminates the last line" reading because the terminator is
guaranteed rather than incidental.

## Undo is per CHANGE COMMAND, not per operation

`u` after `s` + Esc did nothing visible except step the cursor right, and the
second `u` did the work. That is what "one undo entry per mutation" looks like:
the deletion and the insert it opened were recorded separately, so the first
entry had identical text and only a different cursor.

The unit is the *change command*. Everything a command does — the delete and the
typing that follows it — is one step, and an entry that changed no text is not a
step at all (`i<Esc>u` must not consume a `u`).

Measured across the references before implementing (the table is what the corpus
now pins):

| Sequence | vim | nvi | busybox |
|---|---|---|---|
| `s<Esc>u` | original | original | original |
| `sX<Esc>u` | original | original | **only the insert undone** (`bc`) |
| `cwX<Esc>u` | original | original | **` def`** |
| `ccX<Esc>u` | original | original | **`\ndef`** |
| `oX<Esc>u` | original | original | **extra blank line** |

So this is one of the places where busybox is the *scope* oracle and not the
behaviour oracle: vim and nvi agree, busybox's per-operation undo does not. The
cases live in `oracle/cases/undo.json`, which runs vim and nvi; the redo
(`C-r`) and multi-undo cases are vim-only, because nvi has a single undo level
(`u` toggles) and busybox has no redo at all.

Recording is a block: `_pushUndo()` opens it on the first mutation of a command,
`_closeUndo()` commits it when the mode returns to NORMAL — which is why the
insert opened by `s`/`cw` is inside the same block, while `:d` (an ex command,
which mutates outside `feed()`) closes its own.

The block also carries the cursor the undo should restore, and that is not the
same place for every command: measured, `aX<Esc>u` returns to 1:2 and
`AX<Esc>u` to the last character of the line (the insert position), while
`oX<Esc>u` returns to where the cursor was before the command, because the line
`o` created no longer exists.

## Screen lines are MEASURED, not computed

A wrapped line has more screen lines than buffer lines, and the engine cannot
derive where a soft wrap happens: it depends on the font, the field's width, tabs,
kerning and `overflow-wrap`. So the host supplies it, exactly like the viewport
capability:

```js
metrics: (offset) => ({ x, y, width, height })   // CONTENT coordinates
```

Content coordinates (the mirror's own space), not client ones, so scrolling
cannot move a screen line out from under the calculation. The adapter answers it
from the same mirror element the block caret uses.

With it, vim's two families are both implemented and they stay distinct:

| buffer lines | screen lines |
|---|---|
| `j k 0 $` | `gj gk g0 g$` |
| `<Up>/<Down>` in vim are screen lines when `'wrap'` is set, and the browser does the same in insert mode - so our arrows and `Home`/`End` are the screen-line ones | |

`gj`/`gk` keep the screen column, which is the character's index within the row
(its left edge), not a pixel centre - measured against vim's behaviour in
`:help gj`. Without a `metrics` capability the g-motions degrade to `j k 0 $`,
which is exactly right for a host that cannot wrap.

**Measuring without joining the layout.** The mirror's positions come from a `Range`
over one text node, not from appending a `<span>` per measurement: a span boundary is
a line-break opportunity, so measuring at a soft wrap *moved* the wrap and every
position after it came out one cell late - which is how "the cursor can go one past the
row's end and `l` lands on the second character of the next row" happened. A `Range`
reads the layout instead of taking part in it. Two further rules: a **space at a wrap
hangs** at the end of the row it fills (it has no cell of its own, so it is reported
where the previous character ends), and content coordinates are **content-box**
relative, because a border-box origin puts row 0 at `y = paddingTop` and rounding
`y / lineHeight` calls that row 1.

**The bug this was hiding.** The mirror used to cache `el.clientWidth` when it was
created, and was only rebuilt on a `window.resize`. Resize the *field* (a container
changes, a sidebar toggles, devtools open) and the mirror keeps measuring at the
old width: every wrapped offset is then measured in the wrong space and the block
caret is drawn at the row's right edge instead of on its character. The mirror's
width is now re-read on every measurement and a `ResizeObserver` invalidates it,
because "the element got narrower without the window resizing" is a normal event
in a web page and was indistinguishable from a rendering bug.

## Replace mode when the host owns insert mode

`R` overwrites instead of inserting. The problem is that the browser does the
typing: we never see the character the user typed, only the input event that
follows it. So the engine keeps a snapshot of the field when `R` was pressed and
rebuilds the buffer on every host edit:

```
snap[0 .. at) + typed + snap[at + consumed ..)
```

`typed` is tracked by diffing each host edit against the previous text (the
browser's insertion at the caret, or its Backspace), and `consumed` counts how
much of the original to drop, stopping at a newline so replacing never eats across
a line break. An edit that does not extend the typed run - a click elsewhere, an
IME commit, a framework rewriting the value - is adopted and the session is
**rebased** at the new cursor rather than dropped: replace mode must not silently
become insert mode, because that is the one change a user cannot see. Three
properties fall out for free:

- **Backspace restores the replaced character**, because the text is recomputed
  from the snapshot with a shorter `typed`, not patched in place.
- **the whole session is one undo step**, because the block opened by `R` does not
  close until insert mode ends.

Measured after implementing, not before: vim, busybox and nvi all agree on
overwriting, Backspace restore, and appending past the end of a line
(`oracle/cases/replace.json`). Only the undo case separates them — busybox's
per-operation undo leaves just the last piece, the same deviation recorded in
`oracle/cases/undo.json`.

**One convention worth stating once:** a `<textarea>` value is line-*separated*
(`"a\nb\n"` is three lines, the last one empty) while the engine's buffer is
line-*terminated*. `buffer.js:fromField()` is the single conversion, used by the
adapter and by the test harness that simulates a host. Without it, a field value
ending in a newline silently loses its empty last line — which is exactly how a
second copy of the host-typing shim in the test suite went unnoticed until replace
mode needed it.

## A mark is a motion, not a jump

Marks arrived as a cursor move in normal mode, which left two of the three things a
motion has to do unimplemented: `d`a` moved the cursor instead of feeding the
operator, and a mark jump in VISUAL did nothing at all. The fix is one definition —
`_markMotion(kind, key)` returns the same motion object the other motions return, so
the plain jump, the operator range and the visual extension all get it, including the
exclusive-linewise rules (`'` is linewise: `d'a` takes whole lines; ``` `` ``` is
charwise and exclusive: `d`a` stops before the mark's character).

Measured across the references, and they split: vim supports all three; nvi supports
the operator form but not the visual one; busybox supports neither, so
`oracle/cases/marks.json` runs the visual cases vim-only.

The generalisation: **a "thing you can jump to" is not a feature, it is a motion**, and
a motion that only exists on one of the three paths is two features missing.

Found while pinning the cases, not fixed at the time (fixed since): after a paste, the
cursor for a charwise register containing a newline differs - vim leaves it at the start
of the pasted text.

**The same lesson, a third time.** `gg` had exactly the mark bug: it existed only as a
cursor move, so `dgg` moved the cursor and dropped the pending operator, and `gg` in
visual mode did nothing. Both now come from one table of g-motions dispatched like any
other motion, so a plain jump, a pending operator and a visual extension see the same
set. A motion implemented on one path is two features missing - once is a bug, three
times is a rule: when adding a motion, wire it through the dispatch, never straight to
the cursor.

## The case operators: gu / gU / g~ (2026-11-15)

Three operators that map a range's letters to lower, upper or toggled — the same
`_applyCaseRange` for every form, so the motion form, a text object, the doubled line form
and the visual form cannot disagree. Measured against vim 9.2 in
`oracle/cases/case-ops.json` (29 cases):

| form | keys | result |
|---|---|---|
| motion | `gUiw`, `gUe`, `gU$`, `gUb`, `gUj` | uppercases what the motion selects |
| text object | `gUiw`, `gUap`, `gUi"` | …what the object covers |
| doubled | `gUU`, `guu`, `g~~` — and vim's long spellings `gUgU`, `gugu`, `g~g~` | the whole line, `2gUU` = two lines (a count on either side works: `2gUgU` and `gU2gU`) |
| count | `3gUw` and `gU2w` | both sides work (before the `g`, after the operator) |
| g-motion | `gUG`, `gUgg` | to the end / to the start of the buffer |
| visual | `U`, `u`, `~` | the selection |

Four rules, all measured:

1. **Only LETTERS change.** `gUU` on `a1-b_2` gives `A1-B_2` — digits, punctuation and
   underscores are untouched by definition, not by a case filter.
2. **The cursor lands at the START of the range** (`wgUiw` on `alpha beta gamma` reports
   the `b` of `beta`), for the doubled and visual forms too.
3. **Registers are untouched.** `gUiw` is not a yank: `p` afterwards still pastes whatever
   the register held. This is why the case branch sits *before* the register write in
   `_applyOperatorRange` rather than beside it.
4. **No change → no undo step.** `gUiw` on text that is already upper leaves the buffer
   alone, so `u` afterwards undoes something else.

**The one rule that is not obvious: a case mapping may not change the character COUNT.**
vim's default `'casemap'` is `internal`, which preserves the length — measured: `gUiw` on
`straße` gives `STRAẞE`, one character in and one out. JavaScript's `toUpperCase()` turns
`ß` into `SS`, **two** characters, which would shift every offset after it in the field, and
a text field *is* an offset model. So `_caseChar` refuses a mapping whose result is not one
character and leaves the character as it was. Consequence: `straße` uppercases to `STRAßE`
here and `STRAẞE` in vim — a measured divergence on that class only, kept because the
alternative is corrupting every offset after the ß.

### Two gaps, recorded rather than hidden

| Not covered | vim | here |
|---|---|---|
| `.` after a case operator | repeats the operator with its MOTION (`gUiw` then `j.` uppercases the next word) | replays the recorded absolute range, exactly as `dw` + `.` already does — the documented `.` approximation. No new debt, but it looks wrong when the cursor has moved |
| a case operator over a quote object from OUTSIDE the quotes (`gUi"` with the cursor before the `"`) | searches forward for the object | nothing: our quote object only matches when the cursor is inside or adjacent, and `ci"`/`di"` behave identically — a pre-existing text-object limitation, not a case-operator one |

## Visual `r`, and where `u` puts the cursor after a visual change (2026-11-15)

`vllrX` — replace every selected character — is one range-shaped edit, which is why it is
in: the visual operators already compute a range (`_visualRange()`) and already mutate it,
so this is the smallest possible addition to a mode that is *itself* beyond baseline
(busybox has no visual mode at all).

Measured against vim 9.2 (`oracle/cases/visual.json`):

| keys | input | result |
|---|---|---|
| `vllrX` | `abcdef` | `XXXdef` |
| `vrX` | `abcdef` | `Xbcdef` (a one-character selection still replaces) |
| `v$rX` | `abcdef` | `XXXXXX` |
| `vjllrX` | `abcdef\nghijkl` | `XXXXXX\nXXXjkl` — line breaks are NOT replaced |
| `VrX` / `VjrX` | `abcdef\nghijkl` | `XXXXXX` / `XXXXXX\nXXXXXX` — a linewise selection also means "each character" |
| `vllr<Esc>` | `abcdef` | unchanged: `r<Esc>` aborts |

Two bugs came out of implementing it, both pre-existing and both fixed here:

1. **`r<CR>` inserted the two characters "CR".** `CR` and `Tab` are TOKENS in this
   engine's key notation, and `r` is a command that puts its argument into the buffer, so
   it has to translate them (`_typedChar`). Measured: `3r<Tab>` really is three tabs,
   while `3r<CR>` breaks the line **once** — "abcdef" becomes "\ndef", not "\n\n\ndef" —
   because `r<CR>` means "split here", not "put a break per character". The cursor lands on
   the first character of the new line either way (`r<CR>` at column 1 reports 2:1).
2. **`u` after ANY visual change restored the cursor to the selection HEAD.** vim records
   the START of the changed range, and the two are on opposite ends whenever the selection
   was made backwards: `vll` + `d`/`~`/`>` + `u` returns to 1:1, and `llvhd` + `u` returns
   to 1:2 (the min of the range). It affected visual `d`, `c`, `y`, `~` and `>`, not just
   the new `r`, so `_applyOperatorRange` now takes the snapshot cursor explicitly instead
   of reading `state.cursor` (which holds the head while a selection is live).

**One deliberate divergence.** In *visual* mode vim's `r<CR>` stores literal `^M` bytes in
the buffer (measured: `vllr<CR>` yields `b"\r\r\rdef"`). We replace the characters with
real line breaks instead. A stray control character in a text field is a wart, not muscle
memory — nobody types `^M` on purpose — so this is broken on purpose and recorded here.

`.` does not replay a visual `r`: the last-change record for `r` is a count from the
cursor, which describes a range pointing the other way. A gap, not an approximation.

## Where a put leaves the cursor, and what a visual selection covers

The reported bug ("paste lands the cursor on the wrong character") was one rule; the
audit found three more around it, all measured:

- **The cursor after a put depends on the register kind.** A charwise register that
  CONTAINS a line break leaves the cursor on the FIRST inserted character; a
  single-line charwise register on the LAST; a linewise register on the first pasted
  line. That matters because the next command (`.`, `p`, or a motion) starts there.
- **`p` on an empty line inserts at the LINE START**, not after the line's newline -
  the empty line has no character to paste after.
- **A charwise visual selection excludes its last line's trailing newline** (`v$y`
  yanks "abcdef", and `vjy` on "abcdef\ngh\n" yanks "abcdef\ng"), EXCEPT when the
  cursor sits on the line break itself: an empty line selects its own break
  (`v d` deletes the line, `v y` yanks "\n"), a text object can park the cursor there,
  and a break that does not exist (an empty buffer, an empty last line) selects
  nothing. Getting this wrong made `v y` on an empty buffer yank "\n", so `p` added a
  line where vim does nothing.
- **An empty register pastes nothing** - it must not nudge the cursor either.

One reference quirk NOT followed: in this harness's `-N -u NONE` vim, visual `$` lands
one column past the end when the line has a following line, so `v$y` yanks
"abcdef\n" on a multi-line buffer but "abcdef" on a single-line one. Our engine always
takes the line (the documented behaviour, and what nvi does), and nothing in the
3000-combination sweep depends on the difference.

## When the field does not wrap, a line IS a row

The screen-line machinery above is only needed because a soft wrap makes one buffer
line span several screen rows. A field that does not wrap has exactly one screen row
per buffer line, and then the whole question is arithmetic:

```
row    = the buffer line number
column = the character's index in that line
```

`Engine.metrics` therefore has two answers (`TextareaAdapter.metricsFor`):

- **wrapping field** - the caret mirror, in content pixels, because only the host knows
  where a wrap lands;
- **non-wrapping field** - `{ x: column, y: line, width: 1, height: 1 }`, which is exact
  by construction (no measurement can be wrong) and free (no mirror, no Range, no layout
  flush). `gj`/`gk`/`g0`/`g$` then reduce to `j`/`k`/`0`/`$`, and `H`/`M`/`L`/`C-f`/`C-b`
  become exact, because `viewport()` counts rows and here a row is a line.

`wraps()` decides: an `<input>` never wraps, and a `<textarea>` wraps only when its
`white-space` allows it (`normal`, `pre-wrap`, `pre-line`, `break-spaces`). `pre` and
`nowrap` scroll horizontally instead - and a horizontally scrolling field is the *easy*
case, not a hard one, precisely because the viewport stops being a factor.

**The `<input>` trap.** An `<input>` renders its value literally - one line, spaces
preserved, never wrapped - but its *computed* `white-space` says `normal`, a CSS
inheritance artefact rather than its layout. Copying that into the mirror made it
collapse runs of spaces and wrap long values, so the block was drawn on a line the field
does not have and every offset past the first wrap was wrong. The mirror now forces
`pre` for inputs, and it re-copies the whole text-affecting style on every use, because
a field can change (a theme class, a container resize, a `<textarea>` switched to
`nowrap`) long after attach.

### The join rule lives in one place

`J`, `3J` and visual `J` all go through `_joinPair()`. They did not: the visual handler
had its own regex that replaced each newline-plus-blanks with a single space, so the "two
spaces between" bug survived the fix that was meant to remove exactly that. A visual
selection ending on a blank line reports its last line from `range.to - 1` - `range.to` is
exclusive, and using it made the join eat the following line as well.

## Horizontal scrolling: the screen line is only the VISIBLE part

With `'wrap'` off the "screen line" is not the buffer line either - it is the slice of the
line that is currently on screen, and vim's `g0`/`g$`/`g^` are relative to *that*
(`:help g0`: "when 'wrap' is off, this goes to the first character of the display line").

So the host answers one more question, in buffer offsets on the cursor's line:

```js
hscroll() -> { from, to } | null     // null when the field wraps
```

`TextareaAdapter.hscrollWindow()` binary-searches the caret mirror for the offsets at
the window's edges. Two corrections matter, both measured from the field rather than
assumed:

- **`scrollLeft` counts from the PADDING edge**, while the mirror's `x` is measured from
  the CONTENT edge, so the visible window starts at `scrollLeft - paddingLeft`. Getting
  this wrong shifts `g0`/`g$` one to two characters to the right.
- **the visible width is the content box** (`clientWidth - padding`), not `clientWidth`,
  which includes the padding and made `g$` overshoot by about three characters.

With it:

| command | wrapping field | nowrap, scrolled field |
|---|---|---|
| `g0` | first character of the row | first character on SCREEN |
| `g$` | last character of the row | last character on SCREEN |
| `g^` | first non-blank of the row | first non-blank on SCREEN |
| `0 $ ^` | line start / end / first non-blank | unchanged - still the LINE |

Two things to keep straight, because they are the same word in vim and different things
here: the **row** model (wrap on) and the **column window** (wrap off). Both are gated on
a host capability, and both fall back to the buffer line when the host cannot answer - so
a field that cannot measure still behaves predictably.

The e2e fixture now has a third field, `#hscroll`, with `white-space: pre` and horizontal
scrolling, so this path is exercised rather than assumed.

## Registers: five names, one capability, and a measured refusal

The register set is `src/engine/registers.js`. It is small on purpose, and the part
worth documenting is which parts were *measured and then refused*.

### What is stored

| Name | Write | Read |
|---|---|---|
| `""` | every yank and delete | `p` / `P` default |
| `"a`-`"z` | that name only | that name |
| `"A`-`"Z` | appends to the lowercase name | — |
| `"_` | nowhere, including `""` | nothing (`register empty`) |
| `"+` / `"*` | the system clipboard, via the host cache | the host cache |
| `<C-r>{reg}` | — | inserts that register's text in INSERT mode (the adapter inserts it) |

Measured against vim 9.2 (2026-11-14) and pinned in `oracle/cases/registers.json`,
where the differential harness re-runs vim at test time:

- a **named** yank also fills `""` (but not `"0`);
- a **named** delete also fills `""`;
- the **uppercase** append rule is one condition — linewise if *either* side is,
  otherwise concatenate — and it reproduces all four combinations exactly;
- `"_` suppresses the write entirely, so `"ayy "_dd p` pastes the yank, not the delete.

### What was refused, with the measurements

`"0`, `"1`-`"9` and `"-` are **not implemented**. The reason is not "extra code"; it is
that the family is three interacting rules whose interactions are the feature:

| Operation | `""` | `"0` | `"1`-`"9` | `"-` |
|---|---|---|---|---|
| `x`, `dw`, `D`, `cw`, `viwd` | set | — | — | **set** |
| `dd`, `dj`, `2dd`, `dG`, `d}` | set | — | **rotate, `"1` = text** | — |
| `yy`, `yiw` | set | **set** | — | — |
| `"add` (named, big) | set | — | **rotate anyway** | — |
| `"adw` (named, small) | set | — | — | **not set** |
| `"_dd`, `"_x` | — | — | — | — |
| `.` repeat of a delete | set | — | rotates **again** | — |

So supporting them means classifying every delete as small-or-big (a per-operation
property nothing else in the engine has), implementing a rotation, and keeping the
named-register exception — to buy "walk back through this session's deletes", which is
not what a browser field is for. The rotation is also load-bearing for correctness once
you have it: `.` must rotate again, and a small delete must not. That is a state machine
wearing a register's clothes.

Also refused: `.` (last inserted text — a second recording surface for one case, while
`.` already replays the command by diffing), `q`/`@` (macros — a replay loop whose
recording would have to reconstruct host-owned typing), and **`=`** (see below).
`docs/DECISIONS.md` carries the same table as a decision record; this file carries the
evidence.

### `<C-r>{register}`: the one insert-mode edit the engine performs INDIRECTLY

`<C-r>` in INSERT mode is not a convenience, it is a hazard: an unconsumed Ctrl-R is a
page reload, which loses whatever the user had typed. So the FIRST `<C-r>` is always
consumed, even when the register can never be read, and the pending state is cleared by
Esc. The engine then answers the next key with `{insertText}`, and the **adapter** inserts
it — `setRangeText` plus an `input` event for a textarea, `execCommand("insertText")` for
a contenteditable, which keeps the host's undo entry and cannot delete a chip the text
ends inside. Insert mode belongs to the host; this is that rule applied, not broken.
(`C-w` and `C-u` are the two insert-mode edits the engine does itself — see above.)

A linewise register inserts its lines without the trailing newline: the newline in the
register says "this is whole line(s)", it is not a character to type. Measured against
vim 9.2 (`oracle/cases/registers.json`).

### The `=` register was measured, then removed

It evaluated JavaScript with `new Function`. That works in Chrome's page world and is
refused by the page's own CSP in the hosts that matter most — Lark serves its UI from a
custom scheme, and an Electron `oc://` page carries its own policy. A feature that works
in one home and silently fails in the other two contradicts the only rule this project
has about hosts: the same code everywhere. A JS-subset interpreter would have been the
"proper" fix and is a new subsystem, which is exactly what the scope cap exists to
refuse.

### The clipboard is a capability, not a register

Vim reads `"+` and gets a string. A browser cannot: `navigator.clipboard.readText()` is
asynchronous and permission-gated, and the engine is synchronous by design (it returns
text and a cursor; it never awaits). So the same shape as `viewport` and `metrics`:

```js
new Engine({ clipboard: { read: () => string|null, write: (text) => void } })
```

`src/adapters/clipboard.js` supplies the browser implementation, and the order of its
sources is the whole design:

1. **`document.execCommand("paste")`** — the only SYNCHRONOUS read. It works in a content
   script that declares the extension's `clipboardRead` permission, with no per-page
   prompt. `navigator.clipboard.readText()` from a content script is gated by the PAGE's
   permission — a prompt per site — which is why the async API is the last resort.
   execCommand pastes into the focused element, so a hidden field borrows the focus for
   one synchronous call and gives it straight back; that is acceptable when the user
   pressed `"+p` and not on any background refresh.
2. a `paste` event — synchronous, always available, and the only source in a page world
   where no extension permission exists (Lark, Electron's `oc://`).
3. our own writes (`"+y`, and Ctrl-C in visual mode).
4. `readText()` on focus, attempted and never waited on.

Consequences, documented rather than hidden:

- where every source is unavailable the status line says **"system clipboard unavailable
  in this host"** instead of pretending the clipboard is empty;
- a write is best-effort: `navigator.clipboard.writeText` first, `execCommand("copy")`
  as the fallback (it needs the keypress gesture we are inside, and it restores the
  focus and selection it borrows);
- the extension needs `clipboardRead` for source 1; without the permission (a page world)
  `"+p` degrades to what a `paste` event taught the cache.

The `=` register evaluates **JavaScript**, not Vimscript — the same choice `:s` makes
when it translates vim's regex instead of emulating POSIX. It runs what the user just
typed, in the page, which is the only thing that makes it useful; a page whose CSP
forbids `new Function` gets an explicit status line, and `options.expressionRegister:
false` turns it off for a host that wants no eval at all.

## C-w and C-u inside insert mode (2026-11-15)

Insert mode belongs to the host, so these two are the only insert-mode edits the engine
performs itself: it deletes, and the adapter commits the field. Everything below was
measured — vim 9.2, `busybox vi`, `nvi` 1.81.6 — before it was written:
`oracle/cases/insert-backspace.json` (39 cases, ours against vim) and
`oracle/cases/insert-backspace-refs.json` (the same questions put to the references).

### What the references have

**busybox does not implement either command.** `char_insert()` handles ESC, `^V`, `^D`,
Backspace and Tab; `do_cmd()`'s insert branch forwards *every* byte `>= 1` to it, so the
control byte is inserted **literally** and the buffer grows a `\u0017` / `\u0015`:

```
Ahi<C-w>   vim "foo bar"   busybox "foo barhi\u0017"   nvi "foo bar"
Ahi<C-u>   vim "foo bar"   busybox "foo barhi\u0015"   nvi "foo bar"
```

That is worse than "not implemented": the key silently corrupts the text. **nvi** does
implement both, with classic vi semantics — it removes what the insert typed, never
reaches past the insert start, and never joins a line (vim with `backspace=""` behaves
identically in every row of the matrix below).

So this is a **beyond-baseline (Vim lineage) command**, like text objects and marks, not
a busybox-parity one. The scope rule for it is Edward's (2026-11-15): *implement it
because it is used daily, but do not chase completeness — the corners are not worth
their code.* The corners are listed at the end of this section rather than left to be
discovered.

### The matrix

`␗` / `␕` are the literal `\u0017` / `\u0015` bytes busybox writes into the file.

| keys | input | vim | nvi | busybox | ours |
|---|---|---|---|---|---|
| `A<C-w>` | `foo bar` | `foo ` | `foo bar` | `foo bar␗` | `foo ` |
| `A<C-w><C-w>` | `foo bar` | `` | `foo bar` | `foo bar␗␗` | `` |
| `Axy<C-w>` | `foo bar` | `foo bar` | `foo bar` | `foo barxy␗` | `foo bar` |
| `Axy<C-w><C-w>` | `foo bar` | `foo ` | `foo bar` | `foo barxy␗␗` | `foo ` |
| `li<C-w>` | `foobar` | `oobar` | `foobar` | `f␗oobar` | `oobar` |
| `llli<C-w>` | `abcdef` | `def` | `abcdef` | `abc␗def` | `def` |
| `llliXY<C-w>` | `abcdef` | `abcdef` | `abcdef` | `abcXY␗def` | `abcdef` |
| `A<C-w>` | `foo   ` | `` | `foo   ` | `foo   ␗` | `` |
| `A<C-w>` | `foo.bar` | `foo.` | `foo.bar` | `foo.bar␗` | `foo.` |
| `A<C-w>` | `foo_bar` | `` | `foo_bar` | `foo_bar␗` | `` |
| `A<C-u>` | `foo bar` | `` | `foo bar` | `foo bar␕` | `` |
| `Axy<C-u>` | `foo bar` | `foo bar` | `foo bar` | `foo barxy␕` | `foo bar` |
| `llli<C-u>` | `abcdef` | `def` | `abcdef` | `abc␕def` | `def` |
| `llliXY<C-u>` | `abcdef` | `abcdef` | `abcdef` | `abcXY␕def` | `abcdef` |
| `ji<C-w>` | `abc\ndef` | `abcdef` | `abc\ndef` | `abc\n␗def` | **`abc\ndef`** |
| `ji<C-u>` | `abc\ndef` | `abcdef` | `abc\ndef` | `abc\n␕def` | **`abc\ndef`** |

The last two rows are the one place we differ from vim, on purpose — see below.

### The two rules that are not in the documentation

1. **The insert start is a wall once anything is typed.** `AXY<C-w>` on `foo bar` gives
   `foo bar`, not `foo `: the typed run goes, the word does not. A second C-w then has
   nothing typed before it and takes `bar`. This is what "delete what I just typed" has
   to mean; it is not a `'backspace'` rule (vim's `backspace` cannot turn it off either).
2. **Whitespace before the cursor goes with the word** (`A<C-w>` on `foo   ` empties the
   line), but typed whitespace is still the typed run and still stops at the insert start.

With nothing typed the word before the insert start goes — `A<C-w>` on `foo bar` leaves
`foo ` — which is the case that makes the key worth having, and the one classic vi and nvi
refuse.

C-u is vim's two-part rule, both halves measured: *the entered run* when there is one
(`AXY<C-u>` → `foo bar`), otherwise *the whole line prefix* (`A<C-u>` → ``).
`A<CR>XY<C-u>` clears only the new line, because the entered characters on THAT line are
exactly `XY`.

### The pre-existing-word case, which is the one emulators get wrong

The interesting corner for this command is not the line join — it is pressing `i` inside a
word that is already there and then reaching for Ctrl-W. Two different answers are
defensible ("delete only what I typed" vs "delete back to the word start"), and vim picks
by whether anything has been typed yet:

| keys | input | vim | ours |
|---|---|---|---|
| `lli<C-w>` — inside `alpha`, nothing typed | `alpha beta` | `pha beta` | `pha beta` |
| `lliXY<C-w>` — inside `alpha`, typed `XY` | `alpha beta` | `alpha beta` | `alpha beta` |

Both fall out of the same two rules (the word scan and the insert-start wall), so this is
**zero** case-specific code — which is why it is kept while the line join is not. For
calibration: VsVim, the Vim emulator in Visual Studio and VS Code, gets this case wrong.
It is the example the scope rule in `docs/DECISIONS.md` points at.

### The caret can move mid-insert, and the rules follow

The host owns the caret in insert mode: `<Left>`/`<Right>` move the insertion point and
the engine only learns a new cursor. Both commands are defined against that cursor plus
the insert start, so they follow — measured, all of these match vim:

| keys | input | vim = ours |
|---|---|---|
| `A<Left><C-w>` | `foo bar` | `foo r` |
| `A<Left><Left><Left><C-w>` | `foo bar` | `bar` |
| `lli<Right><Right><C-w>` | `foo bar` | `fobar` |
| `AXY<Left><Left><C-w>` | `foo bar` | `foo XY` |
| `AXY<Left><Left><C-u>` | `foo bar` | `XY` |
| `AXY<Left><Left>Z` | `foo bar` | `foo barZXY` |

### There is no option, and that is the point

The natural way to write this feature is a `'backspace'` option with vim's flags
(`indent`, `eol`, `start`) — which is what the first draft of this change did, and it is
the wrong trade. **An option does not add one case to the test matrix, it multiplies it**:
three flags over two commands over the caret and replace-mode variants is a matrix nobody
will keep running, and the third option in a codebase is where the suite stops being
convincing. So the behaviour is fixed, in one place, with no configuration:

- **what the insert typed** — always deletable;
- **the word before the insert start** — always deletable when nothing is typed;
- **a line break** — never deletable (the deliberate break below).

`'indent'` and `'eol'` therefore have no meaning here at all, and a host cannot configure
them. If a future host really needs the nvi behaviour, that is a fork of the rule, not a
flag.

### What is deliberately not covered

Each of these is **accepted**, with its mechanism, and none of them is a red case in the
suite: a case that asserts a divergence would ossify it.

| Not covered | What happens | Why it stays |
|---|---|---|
| **the line JOIN at column 1** | vim deletes the line break and joins the lines (`ji<C-w>` on `abc\ndef` → `abcdef`); here the key is consumed and the text is untouched | it costs three interacting states — `eol`, `start`, and whether the break was typed by THIS insert or already existed — for a corner that is rarely intended, and an accidental join in a message composer merges two sentences. Undo would fix it, but the cheapest bug is the one that cannot happen |
| `.` after a deletion-only insert | `A<C-w><Esc>j.` deletes a word per line in vim; here `.` repeats an insert that inserted nothing | `.` is recorded by diffing the snapshot, not by recording keys. A real fix is a key-recording buffer — the subsystem `"0`-`"9` and macros were refused for |
| replace mode, nothing typed | vim changes no text but moves its cursor to the previous word's start (`llR<C-w>` then `Z` overwrites `a`, not `c`); here the command is inert | text is identical either way; reproducing a cursor jump that surprises people is not a feature |
| Latin-1 letters | `A<C-w>` on `café` deletes `é` alone; vim deletes the whole word | that is `iskeyword` (192-255), shared with `w`, `b`, `db` and `iw` — a word-motion change, not an insert-mode one |
| IME composition mid-insert | untouched: the key never reaches the engine | composition is the host's; a rewrite during composition is not a deletion |
| a host that rewrites the buffer mid-insert | the replace snapshot rebases on the next host edit, and C-w then acts on what the host left | no measurement covers "reflow *then* C-w" — unmeasured rather than wrong |

### Replace mode: the one corner that cannot be dropped

`R` reconstructs its buffer from a snapshot, so anything that edits text inside it has to
go through that reconstruction. C-w/C-u therefore cannot be "left out" of replace mode —
they either un-type (correct) or they corrupt (a plain deletion leaves the snapshot
disagreeing with the screen, and the next keystroke re-inserts the text the user just
deleted). The un-typing is ~12 lines and shares its rule with the write path
(`_replaceConsumed`, extracted from `applyHostEdit`), so it is the cheapest correct answer
and it removes a duplication instead of adding a surface:

| keys | input | vim = ours |
|---|---|---|
| `RXY<C-w>` — C-w over typed text puts the displaced characters back | `abcdef` | `abcdef` |
| `RXY<C-w><C-w>` — and a deletion past the typed run does nothing | `abc def` | `abc def` |
| `llRXY<C-u>Z` — C-u un-typed, then typing replaces again | `abcdef` | `abZdef` |

Everything else about replace mode already existed; this only teaches it to un-type.

`<C-r>{register}` inside replace mode is a different story and is recorded only so nobody
re-derives it: it needs **no** code at all, because a register insert goes through the same
host-insert path as typing, and the snapshot reconstruction makes it overwrite. It matches
vim (`"aywjR<C-r>a` on `XY\nabcdef` gives `XY\nXYcdef`). As Edward put it on
2026-11-15 - after 20 years of vim - he first noticed the combination *today*: a corner of
a corner, pinned by a case because measuring it cost one line, not because it was worth
building.

## Divergences: closed (2026-11-14)

Three places where we knowingly differed from vim, each one measured first and then
fixed. The list is empty now, which is the point of writing it down: a divergence with a
named mechanism is a work item, and one without is folklore.

| Case | vim | what we did |
|---|---|---|
| `d}` with the cursor on/after the last paragraph | runs to **end of buffer** | fixed: the paragraph motion reports its RAW end (`motion.end`), so an operator can take the rest of the buffer while the cursor stays on a real character. The shape at EOF is also vim's: `Gd}` on the last line **empties** it, `Gdd`/`GdG` **remove** it (an exclusive motion's end is backed off by one character before the linewise conversion) |
| `U`'s cursor column | the column the first change left the cursor in | fixed: the snapshot records that column (`llXU` → 1:2, `lXjllkU` → 1:1, `xxU` → 1:1) |
| `C-e` / `C-y` had no cursor rule | the cursor is pushed down/up when the new window would not contain it | fixed: the engine asks for the scroll and then moves the cursor to the window edge it fell off (`3<C-e>` from line 1 lands on line 4; `G<C-y>` leaves it alone because it is still on screen) |

The paragraph rules are pinned in `oracle/cases/paragraph.json` (15 cases, generated from
vim), the register matrix no longer skips its `d}` cell, and `C-e`/`C-y` have unit tests
against a fake window.

## The cursor never leaves the field

Vim keeps the cursor inside the window; a browser field does not, and our block caret is
an overlay, so a caret scrolled out of view was still drawn - and kept blinking - outside
the field's box. Three pieces fix that, and the order matters:

1. `measure()` returns the RAW position. It used to clamp/hide whenever the caret was
   vertically outside, which made "scroll it into view" impossible: the caller could not
   learn where the caret was.
2. `_scrollToCaret()` runs before drawing: if the raw rect is outside the visible text
   area on either axis, the field is scrolled by the difference and the caret is measured
   again (the scroll moves it).
3. `update()` hides the block only when it genuinely cannot be shown, and judges
   visibility by the field's **border box**, not its padding box: a field scrolled to its
   end leaves the last character a few pixels into the padding, which is exactly where
   the browser draws its own caret. Clipping there hid the cursor at the end of every
   long line.

Three details that made the difference between "roughly right" and right:

- **the block is PAINTED inside the text box** (`clampIntoBox`), while *visibility* is
  judged by the border box. A block drawn over the padding reads as a caret that is too
  far right, even when the character under it really is there.
- **the block's own border counts**: it has a 1px border, and with `content-box` its
  painted width was two pixels wider than the width used to clamp it - which is exactly
  the two-pixel spill into the padding that showed up at the end of a long line.
  `box-sizing: border-box` makes the style width the painted width (and the block the same
  size as the character it covers).
- **the scroll is applied, not re-measured**: after `scrollLeft += dx` the browser applies
  its own caret-reveal scroll at the next layout, so a re-measure still read the old
  `scrollLeft` and left a couple of pixels of overhang. The rect is now shifted by the
  delta the field actually scrolled (read back after the assignment, so clamping at the
  ends is handled).
