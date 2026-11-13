# jsbarevi

A deliberately barebones **vi for browser text fields**, written in JavaScript — textarea, `input`,
contenteditable, and the rich composers inside VS Code, Cursor, Devin, Lark and
OpenCode. No plugin marketplace, no framework. One small engine, one adapter
contract, and a real editor behind `:e` when the field is not enough.

> Status: **engine implemented and verified end-to-end.** 36 cases match real
> `vim` keystroke-for-keystroke, 21 unit tests, and 12 end-to-end checks in real
> Chrome with real key events. Not yet wired into the six Electron hosts - that
> needs the injection seam and one restart per host.

## What works today

```bash
npm test                     # unit 21 · :e transport 6 · oracle cases 36 · vs vim 36
npm run test:e2e             # real headless Chrome, real key events (19)
npm run test:oracle          # the reference editors themselves (36)

npm run dev                  # http://127.0.0.1:8080/test/e2e.html, `:e` proxied
```

### Pointing `:e` straight at pyTextFilter (`:31416`)

The default is `/edit` — the proxy — because a **page cannot** reach
`127.0.0.1:31416` directly: the response is cross-origin and unreadable without
`Access-Control-Allow-*`, and pyTextFilter answers the preflight `OPTIONS` with
`501 Unsupported method ('OPTIONS')`. That is a browser rule, not a setting.

Two ways to get the direct path:

**A. Patch the server (opt-in, one command).** Adds `do_OPTIONS` and CORS headers,
gated on `config["server"]["cors"]`, so default behaviour is unchanged:

```bash
# 1. add do_OPTIONS + CORS headers to the server (idempotent; re-running upgrades)
python3 tools/pytextfilter-add-cors.py ~/workspace/pytextfilter/pytextfilter.py

# 2. flip the flag in its config. Prefer an allow-list over "any origin":
python3 tools/enable-pytextfilter-cors.py ~/workspace/pytextfilter/config.py \
    --origin http://127.0.0.1:8080

# 3. RESTART the server — config is imported once, a running process keeps the old value
#    (if it lives in tmux: tmux kill-session -t edit-server, then start it as before)

# 4. verify the header really appears
curl -si -X OPTIONS -H 'Origin: http://127.0.0.1:8080' \
  -H 'Access-Control-Request-Method: POST' http://127.0.0.1:31416/ | grep -i access-control

# 5. open the fixture against the direct endpoint
#    http://127.0.0.1:8080/test/e2e.html?editor=http://127.0.0.1:31416/
```

Accepted values for `config["server"]["cors"]`: `False` (default, patch inert),
`True`/`"*"` (echo any origin), or a list such as
`["http://127.0.0.1:8080", "chrome-extension://<id>"]` — only those origins get
`Access-Control-Allow-Origin`, everyone else gets nothing. Revert by deleting the
key; the patch then does nothing.

**The classic half-done state** (hit for real): the patch is in the file, `OPTIONS`
answers `204`, and it still fails — because `cors` is missing from the config, so
no `Access-Control-Allow-Origin` is sent. The preflight "passes" and the real
request is then blocked. `:e` now names that case instead of reporting "cannot
reach".

Verified: unpatched answers `OPTIONS` with 501 and no CORS header; patched answers
`204` with the origin echoed, and a page-origin POST is readable.

**B. Run as an extension.** On a `chrome-extension://` origin with
`host_permissions` for `http://127.0.0.1:31416/*`, there is no CORS at all — the
fixture already switches its default to the direct endpoint when it detects that
origin. No proxy, no server patch.

### Trying `:e` against a real edit-server

A browser page cannot POST to a local edit-server directly: the response is
cross-origin (unreadable without CORS) and pyTextFilter-style servers answer
`OPTIONS` with **501**, so a custom header or JSON body would fail at the
preflight. `tools/dev-server.mjs` serves the fixture and proxies `/edit`:

```bash
node tools/dev-server.mjs --editor 127.0.0.1:31416     # pyTextFilter's default port
# or with auth:  --auth user:pass
```

Then open <http://127.0.0.1:8080/test/e2e.html>, press `:e`, edit in the real
editor, and write+quit (`:wq`). The proxy also supplies
`Origin: chrome-extension://…`, which pyTextFilter-family servers expect and a
page cannot forge.

### If `:e` returns 501, the number tells you which 501 it is

| Message | What it means | Fix |
|---|---|---|
| `501 Unsupported method ('POST')` | The page is served by a **static** server (`python3 -m http.server`), so `/edit` lands on a handler with no POST | `npm run dev` — the page must be served by the proxy, not statically |
| `501 Unsupported method ('OPTIONS')` | A **CORS preflight** reached the editor directly, i.e. the page posted at `127.0.0.1:31416` instead of `/edit` | use the default `/edit` endpoint (or the extension origin where no preflight happens) |

`:e` now probes the endpoint before sending and names the cause, so neither of
these should ever surface as a bare status code again.

Implemented: modes (normal/insert/visual/visual-line), counts, operators with
motions and text objects (bracket objects follow Vim's `current_block()`: the
cursor does **not** need to be inside — a backwards search for an unmatched opener,
then a forwards search for the next one), insert entries, replace mode (`R`), `r x X s S C D Y ~ J < > p P u U .`,
marks (as motions too: a plain jump, under an operator — `d`a` — and extending a
visual selection), registers, `f F t T ; ,`, `%`, `w b e W B E`, `{ } ( )`, `0 ^ $ |`,
`G gg H M L z`, the screen-line motions `gj gk g0 g$`, `C-b C-d C-e C-f C-u C-y`,
search via `/ ? n N * #`, the `:` line
(`s d y = list set version features file e w q x`) with ranges and the
translate/refuse regex contract, and the viewport capability.

Undo is vim's: **one `u` per change command**, so `s`, `cw`, `cc` and whatever
you typed after them are undone together (a command that changed nothing is not
an undo step, so `i<Esc>u` does not consume one). Measured against vim and nvi;
busybox's per-operation undo disagrees, which is recorded in `docs/ENGINE.md`.

`R` is real replace mode, not insert: typing overwrites, Backspace restores the
character it replaced, and typing past the end of a line appends (measured against
vim, busybox **and** nvi). Because insert mode belongs to the host, the engine
rebuilds the text from a snapshot taken when `R` was pressed — see
`Engine.applyHostEdit`.

`J` inserts a separator only when the line joined into has **none of its own**: a
trailing space or tab already separates, so no second one is added (measured against
vim and nvi; busybox always inserts one, and is the scope oracle here, not the
behaviour one).

Deliberately approximated, documented in `docs/DECISIONS.md`: `.` replays an
insert by diffing the snapshot (the host owns keystrokes, so they cannot be
recorded), and `H M L z C-b C-d C-e C-f C-u C-y` need an adapter that reports a
viewport — they count **screen rows**, so they stay correct on wrapped text.
Fields that do not wrap — an `<input>`, or a `<textarea>` with `white-space: pre` and
horizontal scrolling — take a shortcut that is not a special case but a simplification:
one buffer line is one screen row, so rows are line numbers and columns are character
indices, computed rather than measured.

`'joinspaces'` is not implemented: vim can insert two spaces after a sentence-ending
punctuation when joining, nvi never does, and this engine follows the `nojoinspaces`
rule, since the option is not part of the `:set` surface in `DECISIONS.md`.

The cursor: in NORMAL and VISUAL the native hairline caret is made transparent
and a block caret is drawn over the character at the engine cursor, measured with
a mirror element so soft wrap, tabs and proportional fonts are handled. In INSERT
the block disappears and the native caret returns.

**Who owns the caret** is the question that decides most of the interaction
behaviour, and the answer has two halves:

- **The engine owns the keys that move a caret and that vi also has.** PageUp and
  PageDown are `C-b`/`C-f`; arrows and `Home`/`End` are the **screen-line** motions
  `gk gj g0 g$`, because that is what the browser does with a caret in insert mode
  (which we cannot change — insert mode is the host's) and what vim's arrows do
  when `'wrap'` is set. `0 $ j k` remain the buffer-line motions they are in vim,
  so a wrapped paragraph behaves like vim *and* like the field. Outside insert mode
  the keys are intercepted like any other command, which keeps the model
  authoritative: an arrow in VISUAL extends the selection instead of the browser
  painting a selection we then have to guess back, and End never leaves the cursor
  one column past the row, which is where the DOM would put it. In INSERT they are
  native.
- **The host owns the mouse.** A click is a caret move that is adopted and clamped
  onto a character (a DOM caret is a position *between* characters and vi's is a
  character); a drag is a selection that is adopted as VISUAL, with the anchor
  where the drag began and the head where it ended, backward drags included. This
  is [Input Vim](https://github.com/matheuskieling/vim-input)'s model
  (`cursor-controller.js`, `getMouseSelection`, `clampCursorToLine`), which is why
  a drag does not need its own mode: the native selection and visual mode become
  the same thing, and whatever the host selects — a mouse drag, Shift+arrow, a
  selection the page makes — becomes the engine's selection. A plain click
  **ends** visual mode, which is vim's rule too (`mouse.c:769`); **Shift+click**
  and **right-click** adjust it instead — the boundary nearest the click moves to
  it and the far one stays, so a click outside the selection grows it and a click
  inside cuts it down (`mouse.c:753`, `mouse.c:934`). In NORMAL mode Shift+click
  starts a selection anchored at the cursor. While a selection is active the
  browser's context menu is suppressed: its Copy would copy the collapsed native
  selection and its Paste would bypass the engine's registers and undo. Pressing
  `Esc` leaves visual mode and brings the menu back.

The native selection is still collapsed the moment it has been adopted, so exactly
one of the two is ever visible; see the overlay note below for why the painting is
ours rather than the OS's.

The command line behaves like vi's, measured against vim, nvi **and** busybox vi
(all three agree): the sigil lives in the input, and deleting the typed text while
leaving the `:` (or `/`, `?`) **keeps** you in the command line — only deleting the
sigil itself leaves it, with focus back in the field. `Esc` and `Ctrl-C` cancel.

| After `:s/x/y/` | vim | nvi | busybox | jsbarevi |
|---|---|---|---|---|
| backspace ×6 → `:` remains | stays | stays | stays | stays |
| backspace ×7 → `:` deleted | exits | exits | exits | exits |

Because a stale cached page is indistinguishable from a broken one, every page
prints its build in three places: `[jsbarevi] 0.1.0+<commit> attached to textarea`
in the console, next to the fixture's title, and — the one that matters when a key
"doesn't work" — in the field itself via `:version`. A tab that was loaded before
your last change keeps its old modules; `no-store` only helps once you reload.

The stamp itself has to be honest, and a file cannot be: `src/build-info.js` is
written by `tools/stamp-build.mjs`, which runs *before* a commit, so the committed
file describes the previous commit — a stale label on current code, which is the
exact confusion the label exists to prevent. So the **dev server computes the stamp
per request** from `git rev-parse` (`tools/build-id.mjs`, the one definition of the
build identity, shared with the stamp script and with packaging). Reloading is now
enough; the label can only ever describe what is being served.

VISUAL and VISUAL LINE paint their own **overlay**: one box per selected line
segment, measured with the same mirror technique as the caret, stretched to the
field's right edge in linewise mode. The native selection is collapsed while the
overlay is up so the two never double-paint, and `Ctrl-C` copies the engine's
visual range instead.

Relying on the native selection was the first attempt and it was wrong in a way
tests alone did not catch: the range *was* set and a pixel *did* change, but the
OS highlight in a dark field is so weak that it was invisible in practice.

## Why another one

Three options existed and none fit:

1. **Vim keybindings in the host** — VS Code has them for the editor, nothing for
   the chat box, and every other app is worse.
2. **A full vim emulation layer** — the ones that exist are either abandoned, or
   they reimplement Vim rather than vi, which is where the bugs come from.
3. **This** — port the *traditional vi* surface, which is small and settled, and
   hand anything complicated to a real editor.

The scope is **88 vi-mode commands** plus an 18-command `:` line. It is not a Vim
clone: no Vim script, no plugins, no ex mode, no `:g`/`:v`. See
`docs/DECISIONS.md` for what is in, out, and why.

## Design in one page

```
┌──────────────────────────────┐
│ engine (pure)                │  keys + buffer + cursor  →  text edits
│ modes · parser · motions     │  no DOM, no host, no async
│ operators · text objects     │  buffer-line semantics (not display lines)
│ marks · registers · . · :cmd │
└──────────────┬───────────────┘
               │  applyEdit(range, text) · version · viewport ...
┌──────────────┴───────────────┐
│ adapter (per host)           │  the only part that knows the host exists
│ textarea · contenteditable   │  maps a flat string ⇄ the host document
│ ProseMirror · Slate · Monaco │  supplies structure, caret, viewport, undo
└──────────────┬───────────────┘
               │  `:e`
┌──────────────┴───────────────┐
│ external editor session      │  real vim on a temp file; compare-and-swap back
└──────────────────────────────┘
```

Three rules that make it stay small:

- **The engine never touches the DOM.** It emits a range and a replacement.
- **The adapter may refuse an edit.** Rich structures win over vi commands.
- **Insert mode belongs to the host.** We never reimplement typing, IME, or paste.

## What is measured, not assumed

`oracle/` runs the same keystroke sequence against real `vim`, `nvi` and
`busybox vi`, and compares buffer + cursor:

```
python3 oracle/run.py            # every engine
python3 oracle/run.py --engine vim -v
```

Oracle of record: **busybox decides scope**, **vim decides behaviour**. The three
disagree often enough that the harness records divergences as cases rather than
hiding them (`S` exists in nvi and vim, not busybox; `gg` exists in busybox and
vim, not nvi).

## Credits and the inheritance boundary

`CREDITS.md` is not decoration: **busybox is GPLv2-only**, so we take its
*behaviour* and never its code. What is inherited from Input Vim (MIT), what is
written from scratch, and what was deliberately dropped are listed there, in one
place, per file.

## Layout

| Path | What |
|---|---|
| `docs/DECISIONS.md` | the frozen surface: 88 commands, 18 ex, exclusions and why |
| `docs/TARGET-SURFACE.md` | per-command three-way matrix (nvi / busybox / us) |
| `docs/ENGINE.md` | engine structure, buffer model, adapter contract |
| `docs/REGEX.md` | the `:s` / `/` contract: translate, refuse, pass through |
| `docs/REVIEW-2026-11-12.md` | independent adversarial review that changed the plan |
| `oracle/` | differential harness + cases |
| `src/` | the engine (not started) |
| `tools/` | build/injection helpers |

## License

MIT for our code; see `LICENSE`, `NOTICE` and `CREDITS.md` for the third-party
picture.

## The audits: one axis for a command, one for a sequence

`tools/audit-align.mjs` answers *"does one command leave what vim leaves?"* — a
command axis over 9 buffer shapes x 6 cursor positions x 51 commands. It cannot
see a rule that only exists **across** commands, which is where `s` + Esc + `u`
lived: the deletion and the insert were two undo steps, and the shape-by-shape
audit was green throughout.

`tools/audit-undo.mjs` adds that second axis, and it needs no reference editor
because it is an invariant rather than a comparison:

> if a command changed the buffer, then the same command followed by `u` must
> restore it exactly.

Run against the engine *before* the undo fix, it reports 80 failures; after, 0.
It is 0.08 s (it only runs our engine), so it sits inside `npm test`. The two
audits share one matrix definition (`tools/alignment-matrix.mjs`) — a matrix in
two files is a matrix that is right in one of them.

Adding `s`, `S`, `C` and `2s` to that matrix immediately paid for itself: the
first run found **31 combinations** where `s` inserted in the wrong place. `s`
had been letting its delete place the cursor (`$s` on `abc` deleted `c`, the
delete clamped the cursor left, and the typed text landed before `b` instead of
after it), so `_enterInsert` now takes the position the deletion started at.
Command coverage is a decision, not a detail: the bug that started this was in a
command the matrix did not contain.
