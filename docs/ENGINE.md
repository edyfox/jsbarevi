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

Found while pinning the cases, not fixed: after a paste, the cursor for a CHARWISE
register that contains a newline differs (vim leaves it at the start of the pasted text,
we put it at the end). Separate rule, separate measurement; recorded in the session
notes rather than guessed at.
