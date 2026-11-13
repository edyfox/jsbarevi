# The extension package

`extension/` is the product surface; `src/` is unchanged by it. This document covers
what the package is, why it is built the way it is, how to load it, and what will
bite you.

```bash
npm run build:ext     # dist/ + dist/jbarevi-<version>.zip  (upload this)
npm run test:ext      # build + 24 assertions in real Chrome for Testing
npm run store:shots   # regenerate the store screenshots from the real engine
npm run icons         # regenerate the icon set
```

## What is in `dist/`

| File | What |
|---|---|
| `manifest.json` | MV3. Version from `package.json`, `version_name` = `0.1.0+<commit>` |
| `content.js` | **one classic script**: the engine (all of `src/`) plus `extension/src/content.js` |
| `escape-blocker.js` | MAIN-world `document_start` patch: a site cannot `blur()` a field we own |
| `background.js` | the service worker: the only context that may fetch cross-origin |
| `popup.html/.css/.js` | the toolbar UI: switches, `:e` endpoint, key card |
| `icons/` | 16/32/48/128 |
| `build.json` | the stamp the package was built from |

## Why a build step when `src/` has none

Two hard constraints, one artefact:

1. **A content script cannot use `import`.** Chrome loads it as a classic script.
   Loading an ES module into a page would mean `chrome.scripting` with
   `world: "MAIN"` or a web-accessible module — more moving parts, and it breaks the
   second constraint anyway.
2. **Electron hosts inject the same file into a page world.** OpenCode Desktop's
   renderer is served from `oc://`, a scheme content-script match patterns reject
   outright, so the host patch injects the extension's content scripts itself by
   concatenating them and running them via `executeJavaScript`. In that world there
   is no `chrome.runtime` at all: a dynamic `import()` of an extension URL cannot
   work, and neither can messaging.

So: one file, no module loader, no runtime resolution. esbuild bundles; nothing is
transformed. `tools/build-extension.mjs` asserts the output has no module syntax,
because that failure mode is a silent syntax error on a user's machine.

`esbuild` is the only dependency and it is a devDependency — the engine still runs
unbundled in the page fixture.

## The `:e` transport seam

Moved into the extension, the old story ("a page cannot read a cross-origin reply")
becomes avoidable: the service worker holds `host_permissions` for `127.0.0.1` and
`localhost`, so it has no CORS to fight. That is one seam in
`src/adapters/editor-session.js`:

```js
this.fetch = opts.fetchImpl || ((...args) => fetch(...args));
```

`content.js` supplies `workerFetch`, which talks to the worker over a **port**, not
`sendMessage`. Two reasons, both learned the hard way:

- a service worker is torn down after ~30 s of idleness and an editor session runs
  up to 15 minutes; the client pings every 20 s to keep it alive;
- one-shot messages have nowhere to put a 15-minute reply.

The worker does not know the protocol: URL, method, headers and body all come from
the adapter, so the wire format has exactly one definition.

Where there is no worker (Electron's page-world copy) the seam falls back to a plain
`fetch` — the same request a page would have made, with the same diagnostics. The
decision is a real round trip (`jsbarevi:ping` → the worker answers), not a feature
test: Electron *loads* the extension but never runs an MV3 worker, so
`chrome.runtime.connect` exists and produces a port nobody will ever answer.

## Two things that are only true outside Chrome

Written down because both cost an install to find:

- **Settings may arrive callback-style.** Chrome's `chrome.storage.local.get`
  returns a promise (and accepts a callback); Electron hosts that inject the content
  script into a page world supply a localStorage-backed shim that is
  **callback-only** and returns `undefined`. `loadSettings()` therefore handles both
  — reading only one style silently ignores whichever host chose the other.
- **The overlay CSS is a constructable stylesheet** (`document.adoptedStyleSheets`)
  rather than an inline `<style>` element. A host with a strict `style-src` — an
  Electron app served from a custom scheme, a webview, Lark — refuses the inline
  element, and the badge would render as unstyled text over the page. CSSOM
  insertion is not subject to `style-src`; the `<style>` path remains as a fallback.
  The extension test asserts the computed `position: fixed`, so a regression fails
  the suite rather than looking slightly wrong in one host.

## What attaches, and when

- **On focus**, one adapter per element, never two (a second engine would double
  every keystroke).
- **Also on load** if the page autofocused a field before the content script ran —
  without that, an autofocused field looks broken until the user clicks away.
- Never: `readonly`/`disabled` fields, `<input type=password|number|date|…>`,
  anything inside `[data-jsbarevi="off"]`, and contenteditable (not implemented —
  there is no adapter for it yet; the `contenteditable` adapter is the next piece of
  engine work).
- The command line is an `<input>`, so the UI marks itself `data-jsbarevi-ui` and
  eligibility refuses it. Without that marker the engine attaches to its own prompt.

A page can opt out for a subtree with `data-jsbarevi="off"`, or suspend the extension
for itself by dispatching `jsbarevi:suspend` with `detail: true` (and `false` to
resume).

## Contenteditable: the composer case

A `<textarea>` gives you `.value` and `selectionStart`. A rich composer gives you a
DOM, a `role="textbox"`, own key handling, its own model, and chips. The adapter for
that is `src/adapters/contenteditable.js`, and its DOM primitives are **ported from
Input Vim** (`content/handlers/contenteditable-handler.js`, MIT) rather than
re-derived — that project solved this across six hosts:

| Rule | Why it is not obvious |
|---|---|
| The field is a list of BLOCKS joined by `\n`; with no block children the element is one block | `text<br>text` is a single block with an internal newline — treating `<br>` as a block boundary doubles every line |
| A `<br>` with nothing meaningful after it is a **placeholder** | every browser leaves one to make the last line reachable; counting it turns a one-line field into two |
| An element inside the text contributes its **text**, and offsets inside it stay inside it | a mention chip is also an element the host keeps a reference to |
| Edits go through the **selection + `execCommand`** | it deletes a chip whole, keeps the host's undo stack coherent, and works in editors that `preventDefault` on `beforeinput` |

### Escape must not leave the field

A site's Escape handler usually means "leave this input", and it implements that with
`el.blur()` — a function call, which `preventDefault()` cannot cancel. Two defences,
both needed:

A host has two shapes for "Escape leaves the input", and they need different answers:

- **`el.blur()`** — a programmatic blur; `preventDefault()` cannot cancel it, so the
  MAIN-world prototype patch below handles it.
- **`other.focus()`** — focus moved away. No prototype patch can stop this without
  breaking legitimate focus moves, and it is the shape that looks like *"Escape worked,
  but the field is dead until I press another key"*: the key that follows lands on
  whatever the host focused, so the engine never sees it. The content script therefore
  opens a **600 ms window** after a consumed Escape and reclaims focus from anything that
  is not a field we own, not our own command line, and not a real click (pointer events
  set a timestamp the window respects). Attempt-capped at three, so a host with a focus
  loop cannot turn it into a fight, and a `console.info` names whatever took the focus.

### The third defence: the keyup, and the focus loss itself

Two more mechanisms, both **ported from Input Vim**, and both are what make this work
next to another key-binding extension (Vimium binds Escape on the same pages):

1. **Escape on `keyup`.** A competitor that eats the keydown and calls
   `stopImmediatePropagation` also eats our chance to answer it — but nobody eats the
   keyup. `event-interceptor.js` says it plainly: *"Escape fallback: if keydown was
   swallowed by the page, handle Escape on keyup"*. Ours does the same, pairing the
   events with a flag (set when our keydown consumed an Escape, cleared by its own
   keyup) rather than a time window, which is a race.
2. **A focus loss without a click is an Escape.** `focus-manager.js`: if the field loses
   focus and no pointer press preceded it, leave the current mode and take the focus
   back. Tab and "focus moved to another field" are exempt. This needs no key at all,
   which is the point: it is the only mechanism that survives a key we never receive.

Every decision in that handler runs **after focus settles** (`requestAnimationFrame`),
because inside `focusout` `document.activeElement` is still the old node — deciding there
stole focus from the element the user had just moved to.

Both sit under the same first defence:

1. **Capture on the document at `document_start`** (the content script runs before the
   page's own scripts), so a consumed Escape never reaches the host's handler.
2. **A MAIN-world prototype patch** (`extension/src/escape-blocker.js`, ported from
   Input Vim): while an element carries `data-jsbarevi-mode`, a programmatic `blur()`
   from page code is ignored. It has to be the page's world — a content script's
   isolated world has its own `HTMLElement.prototype` and patching it changes nothing
   for the site. The marker is removed on `destroy()`, so a site the user turned the
   extension off for keeps its normal behaviour.

Three things that are ours, not the reference's:

- **Keydown is captured on the document**, not the element, and a consumed key calls
  `stopImmediatePropagation`. A composer registers its own handler (Enter sends,
  arrows walk history) — and a listener added to the element later runs *after* it.
  Without this, `j` navigates and Enter both moves a line and sends the message.
- **Edits are still surgical**: the engine returns a whole buffer, so we diff it and
  apply only the changed span. A rewrite would destroy the host's document.
- **`u` restores markup, not text.** A text diff cannot re-create an element, so a
  snapshot of the host's HTML is kept per text state and an exact restoration puts the
  markup back — undoing a deleted mention returns the mention, not the string
  `@a.ts`. (Same idea as Input Vim's innerHTML undo stack, scoped to states we saw.)

Two measured traps, both fixed and both pinned by `npm run test:ce`:

- **`execCommand` normalizes a selection that ends inside a non-editable element**: a
  range from the end of the text before a chip to one character *into* the chip
  deletes the TEXT and keeps the chip. So no selection endpoint may land inside one —
  both boundaries snap to the element's edge, which is what `x` on a mention means.
- **A deletion may remove more than asked.** The adapter re-reads the DOM after every
  edit and adopts what really happened instead of insisting on its own buffer.

## Settings

`chrome.storage.local`, three keys — nothing else is stored anywhere:

```js
{ enabled: true, disabledHosts: [], editorUrl: "http://127.0.0.1:31416/" }
```

A change applies immediately to the *switches* (enabled → detach everything,
per-host → detach). `editorUrl` applies to the next attachment, because the transport
is built per adapter — the endpoint belongs to the session, not to the keystroke.

## Installing it

**In Chrome, for use.** `chrome://extensions` → Developer mode → **Load unpacked** →
select `dist/`. (Reload the extension after a rebuild; a page loaded before that
keeps the old copy.)

**In the Web Store, for everyone.** Upload `dist/jbarevi-<version>.zip`. Listing copy,
permission justifications, screenshots and the privacy policy are in `store/`
(`listing.md`, `PRIVACY.md`, `screenshots/`, `promo-440x280.png`). The listing needs a
**public privacy-policy URL** — host `store/PRIVACY.md` and paste the URL.

**In an Electron host (OpenCode Desktop, VS Code-family).** Copy `dist/` into the
host's unpacked-extension directory (for OpenCode,
`~/.local/share/opencode-desktop-extensions/jbarevi/`) and restart. The host patch is
what makes the app's `oc://` window receive content scripts at all; see
`_local/scratchpad/ext-injection/opencode.md` for the loader's rules. Two consequences
specific to that world: settings fall back to `localStorage` (`chrome.storage` is not
there), and `:e` needs a `pyTextFilter` that allows the `oc://` origin.

## Test traps that cost real time

- **Branded Chrome ignores `--load-extension` and `--disable-extensions-except`**
  (137+). The extension test therefore requires **Chrome for Testing**
  (`test/lib/cdp.mjs` finds the newest one under `~/.cache/puppeteer/`; `CHROME=`
  overrides). A human can still load unpacked from `chrome://extensions`.
- **Chrome's own component extensions use `background.js` too** (Gemini in Chrome,
  Contextual Tasks). Identify the extension under test by the name its worker
  reports — matching on `/background.js$/` tested somebody else's extension and
  produced two confidently wrong assertions.
- **Screenshots are generated from the engine, not mocked.** `npm run store:shots`
  loads `dist/` in Chrome for Testing, drives real keys on `store/demo.html`, and
  fails if an image is not 1280×800.

## Known limitations, stated rather than hidden

| Limitation | Why |
|---|---|
| A yanked mention is put back as its text, not as a chip | one buffer character cannot describe an element; the host's own chip is restored only by `u` (markup snapshot) |
| Framework editors that `preventDefault` on `beforeinput` (CKEditor, ProseMirror) may refuse an edit | reported through the status line as "this editor refused the edit"; Input Vim bridges into the editor's JS API, we do not (scope) |
| Ctrl-W / Ctrl-R are consumed while a field is focused | they are vi's `C-w` / `C-r`; a field that swallowed neither would be a field where vi half-works. Esc or a click outside gives the browser back |
| Esc never blurs the field | vi's rule; Tab leaves |
| `:e` needs a local server | by design — it is the "hand this to a real editor" escape hatch, not a remote service |
| A page that stops `focusin` in capture on `document` ahead of us | discovery rides that one event; there is no per-field fallback, so such a page would never attach |
