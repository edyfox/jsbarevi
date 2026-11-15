# jsbarevi

A deliberately barebones **vi for browser text fields**, written in JavaScript — textarea, `input`,
contenteditable, and the rich composers inside VS Code, Cursor, Devin, Lark and
OpenCode. No plugin marketplace, no framework. One small engine, one adapter
contract, and a real editor behind `:e` when the field is not enough.

> Status: **engine verified end-to-end, packaged as a Chrome extension, and running in
> rich composers (contenteditable) as well as plain fields.**
> 294 differential cases match real `vim`, 160 engine cases, 109 unit, 180
> end-to-end checks in real headless Chrome, and 24 more that drive the *packaged*
> extension (content script, settings, service-worker transport) in Chrome for
> Testing. The unpacked extension loads today; the Web Store package and listing are
> built by `npm run build:ext` — see `docs/EXTENSION.md`.

## What works today

```bash
npm test                     # undo audit · unit · transport · engine · differential
npm run test:e2e             # real headless Chrome, real key events
npm run test:ext             # the PACKAGED extension in Chrome for Testing (29)
npm run test:ce              # contenteditable composer: chips, host keymap, host model
npm run test:matrix          # registers x every command form that writes one
npm run coverage             # V8 block coverage: functions that never ran
npm run test:oracle          # the reference editors themselves

npm run dev                  # http://127.0.0.1:8080/test/e2e.html, `:e` proxied
npm run build:ext            # dist/ + the Web Store zip
```

### Installing it in a browser

```bash
npm run build:ext
# then: chrome://extensions → Developer mode → Load unpacked → choose dist/
```

Everything about the package — why it is one bundled classic script, how `:e` gets
around CORS without a server patch, what attaches to which field, and the store
publishing checklist — is in [`docs/EXTENSION.md`](docs/EXTENSION.md).

### Turning it off in one field: `:q`

A host's editor can be more trouble than it is worth (a composer that eats keys, a field
whose model fights every edit). `:q` in NORMAL mode hands **that field** back to the
browser, without uninstalling anything:

- focus stays in the box, the native caret comes back where the vi cursor was, and typing
  goes straight in — it is a modeless text box again;
- every hook goes with it: the key handling, the focus guard, the `data-jsbarevi-mode`
  marker that the MAIN-world blur patch reads, the badge and the overlay;
- vi returns **when the field loses focus and is focused again** — not on the next
  keystroke, or `:q` would undo itself as soon as you typed.

`:q!` does the same. `:q` with an **open** `:e` session still closes that session (the
transcript is the editor's); an idle transport is not "open", so `:q` means what the user
means. In the extension this lives in the content script, so it applies in every host the
bundle runs in — Chrome pages and an Electron page world alike.

### Pointing `:e` straight at pyTextFilter (`:31416`)

[pyTextFilter](https://github.com/edyfox/pytextfilter) is this project's author's
earlier tool, and `:e` speaks its wire protocol, so a server that has been editing
remote files over SSH for years serves a browser field with no changes.

The default is `/edit` — the proxy — because a **page cannot** reach
`127.0.0.1:31416` directly unless the server opts in: the response is cross-origin
and unreadable without `Access-Control-Allow-*`, and an unconfigured pyTextFilter
answers the preflight `OPTIONS` with `501 Unsupported method ('OPTIONS')`. That is
a browser rule, not a setting — the two ways to satisfy it are below.

Two ways to get the direct path:

**A. Patch the server (opt-in, one command).** Adds `do_OPTIONS` and CORS headers,
gated on `config["server"]["cors"]`, so default behaviour is unchanged. A current
pyTextFilter checkout already has it; the tool upgrades an older copy:

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

A `*` **inside** an entry matches any run of characters, so
`["http://localhost:*"]` admits every port on localhost — what a dev server needs,
since its port changes per project — and `host:*` also admits the default-port form
a browser sends with no port at all. Hosts are never aliased: `localhost` and
`127.0.0.1` are different origins, and on ChromeOS they can resolve to different
machines (the browser's localhost is not a Linux container's), so list each one:

```python
"cors": ["http://localhost:*", "http://127.0.0.1:*"]
```

**Installing the patch without configuring it is a true no-op**: with `cors`
unset, `OPTIONS` still answers `501` and no CORS header is sent, exactly like the
stock server. The failure that *does* bite is patched **and** configured with the
wrong origin: `OPTIONS` answers `204`, but no `Access-Control-Allow-Origin` comes
back for that origin, so the preflight "passes" and the real request is then
blocked. `:e` names that case instead of reporting "cannot reach".

Verified: unpatched answers `OPTIONS` with 501 and no CORS header; patched answers
`204` with the origin echoed, and a page-origin POST is readable.

**B. Run as the extension.** The package ships with `host_permissions` for
`http://127.0.0.1/*` and `http://localhost/*` and routes `:e` through its service
worker, so there is no CORS at all and no server patch: point the popup's endpoint at
`http://127.0.0.1:31416/` and `:e` works. The page fixture also switches its default
to the direct endpoint when it detects a `chrome-extension://` origin. See
`docs/EXTENSION.md`.

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
visual selection), registers, `C-a` / `C-x` (increment/decrement with counts — the
number under the cursor or the next one on the line, decimal/hex/binary/octal, `.`
repeats it), `f F t T ; ,`, `%`, `w b e W B E`, `{ } ( )`, `0 ^ $ |`,
`G gg H M L z`, the screen-line motions `gj gk g0 g$ g^`, `C-b C-d C-e C-f C-u C-y`,
search via `/ ? n N * #`, the `:` line
(`s d y = list set version features file e w q x`) with ranges and the
translate/refuse regex contract, and the viewport capability.

Insert mode has two deletions of its own, because the browser's answer to both is
destructive: `C-w` deletes back to the start of the word before the cursor and `C-u`
deletes back to where the insert began (both measured against vim — see
"C-w and C-u inside insert mode" in `docs/ENGINE.md`). They are consumed in every
host, but they only *earn* their keep where the browser does not own the key: Chrome
itself reserves Ctrl-W as close-tab, while a PWA window, an Electron app and a page
that dispatches its own keymap (an OpenCode composer) do not.

Registers: the unnamed `""`, one-character names `"a`-`"z` with the Vim append form
`"A`-`"Z`, the black hole `"_`, and the system clipboard as `"+` — with `"*` aliased to
it, because a browser has one clipboard and inventing a second one we cannot fill would
be a lie. `<C-r>{register}` inserts one in INSERT mode, which is the fast route from the
clipboard into a field (and the reason Ctrl-R never reaches the browser: that reloads the
page). Deliberately **not** implemented, each for a stated reason in
`docs/DECISIONS.md`: the numbered family (`"0`, `"1`-`"9`, `"-` — three interacting
rules measured against vim 9.2, buying only "walk back through this session's deletes"),
`.` (a second recording surface) and `"=` (it needs eval, and a page's CSP refuses that in
two of the three homes). `docs/ENGINE.md` carries the measurements.

Undo is vim's: **one `u` per change command**, so `s`, `cw`, `cc` and whatever you typed after them are undone together (a command that changed nothing is not
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
behaviour one). The same rule serves `3J` and visual `J` - one implementation, so they
cannot disagree.

Deliberately approximated, documented in `docs/DECISIONS.md`: `.` replays an
insert by diffing the snapshot (the host owns keystrokes, so they cannot be
recorded), and `H M L z C-b C-d C-e C-f C-u C-y` need an adapter that reports a
viewport — they count **screen rows**, so they stay correct on wrapped text.
Fields that do not wrap — an `<input>`, or a `<textarea>` with `white-space: pre` and
horizontal scrolling — take a shortcut that is not a special case but a simplification:
one buffer line is one screen row, so rows are line numbers and columns are character
indices, computed rather than measured. There is a second, odder consequence that vim
shares: with `'wrap'` off, `g0`/`g$`/`g^` are relative to the **visible column window**
rather than to the line, so after scrolling sideways `g0` goes to the first character on
screen. `0`/`$`/`^` keep their line meaning. The fixture's `#hscroll` field is there to
exercise exactly this, and the cursor is always scrolled into view rather than left
outside the field (vim's behaviour; a browser field would happily let it sit there).

`'joinspaces'` is not implemented: vim can insert two spaces after a sentence-ending
punctuation when joining, nvi never does, and this engine follows the `nojoinspaces`
rule, since the option is not part of the `:set` surface in `DECISIONS.md`.

The cursor: in NORMAL and VISUAL the native hairline caret is made transparent
and a block caret is drawn over the character at the engine cursor, measured with
a mirror element so soft wrap, tabs and proportional fonts are handled. In INSERT
the block disappears and the native caret returns.

The overlay's **palette follows the page**: dark chip, green caret and pale blue
selection on a dark document; on a light one the chip turns white with a ring,
the text goes dark and the caret/selection get darker and more opaque, because the
dark-tuned colours are invisible there. Detection is per field (walking up to the
first ancestor that paints), the switch point is the luminance at which dark text
has the better contrast ratio, and it repaints live when a host re-themes.
`data-jsbarevi-theme="light|dark"` overrides it. See
[`docs/EXTENSION.md`](docs/EXTENSION.md#the-palette-follows-the-page-not-the-os).

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

## Inside an app with no extension system (Lark)

Lark on Linux is not Electron: its extension system and devtools are compiled out of
`liblark.so`, and the UI is served from `native-resource://`, so no content-script match
pattern can apply. What does work is the asar entry every shell loads —
`resource.asar → js/after-js-load.js` — which the personal `lark-ext-patch` tool
appends to and rebuilds with its integrity recomputed.

```bash
npm run lark:payload                    # dist/lark-payload.js: bundle + gate + beacon
# then, with the installer from the workspace:
LARK_PAYLOAD_FROM=$PWD/dist/lark-payload.js ../../_local/bin/lark-ext-patch patch
# restart Lark
npm run test:lark                       # the payload against a Lark-shaped page
```

Three things the payload adds on top of the bundled content script, because a page world
has none of them:

- **A gate.** The script loads in every Lark shell and the Docs/Bitable editors are
  contenteditable too, so the payload defines `globalThis.jsbareviHostGate` and the
  content script refuses every field it rejects. The selector (`[class*=chat]`) is read
  at page load from a local beacon, so retuning needs no re-patch.
- **The `blur()` patch**, normally a separate MAIN-world content script; in Lark the
  payload already runs in the page's world.
- **A beacon**, because there is no devtools and no extension console to read a
  diagnostic from.

Settings need no shim: with no `chrome.storage` at all, the content script falls back to
its defaults plus `localStorage["jsbarevi:settings"]` — the path Electron hosts already
proved. `:e` is the one thing that does not travel: a page on a custom scheme may not
fetch `http://127.0.0.1`, so Lark refuses it, and the status line says so.

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
| `docs/EXTENSION.md` | the package: bundle, `:e` transport, settings, install, store |
| `docs/REVIEW-2026-11-12.md` | independent adversarial review that changed the plan |
| `oracle/` | differential harness + cases |
| `src/` | the engine |
| `extension/` | manifest, content glue, service worker, popup, icons |
| `store/` | listing copy, privacy policy, screenshots, promo tile |
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

`test/registers-matrix.mjs` is the third axis, and it came from a real miss: `"+yy`
worked while `"+yaw` silently did not, because one command path never looked at the
prefix. Fixing the cell a human hit is whack-a-mole; the matrix enumerates 41 command
forms (every code path that writes a register) against five registers, asserting nine
things per cell — the named register carries what the unnamed one carries, pasting it
reproduces **vim's** buffer, `+` mirrors it, `_` writes nothing, `A` appends, and an
unsupported name aborts the command. Two pre-existing motion bugs fell out of it
(`t` under an operator, and where `{` lands); both are fixed and pinned in
`oracle/cases/motions.json`.

`npm run coverage` answers a different question — *did this code ever run at all?* — and
it has already retired a whole class of "works until you try it": `*` and `#` were broken
for everyone (`\<`/`\>` are vim syntax, literal `<` to JavaScript), `U` only worked after
insert mode, and one switch arm was unreachable. Engine function coverage is now 98/98,
with the method and the findings written up in `docs/ENGINE.md`.

`tools/audit-undo.mjs` adds the sequence axis, and it needs no reference editor
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
