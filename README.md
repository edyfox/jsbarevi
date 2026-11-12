# jsbarevi

A deliberately barebones **vi for browser text fields**, written in JavaScript, — textarea, `input`,
contenteditable, and the rich composers inside VS Code, Cursor, Devin, Lark and
OpenCode. No plugin marketplace, no framework. One small engine, one adapter
contract, and a real editor behind `:e` when the field is not enough.

> Status: **specification frozen, harness working, engine not started.**
> See `docs/DECISIONS.md` for the frozen surface and `oracle/` for what is
> measured so far.

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
