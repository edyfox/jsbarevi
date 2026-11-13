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
`fetch` — the same request a page would have made, with the same diagnostics.

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
| No contenteditable yet | needs the rich-text adapter (next engine work); the extension simply does not claim those fields |
| Ctrl-W / Ctrl-R are consumed while a field is focused | they are vi's `C-w` / `C-r`; a field that swallowed neither would be a field where vi half-works. Esc or a click outside gives the browser back |
| Esc never blurs the field | vi's rule; Tab leaves |
| `:e` needs a local server | by design — it is the "hand this to a real editor" escape hatch, not a remote service |
| A page that stops `focusin` in capture on `document` ahead of us | discovery rides that one event; there is no per-field fallback, so such a page would never attach |
