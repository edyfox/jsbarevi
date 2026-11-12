# Credits and inheritance boundary

Three projects inspired this, one is a specification, one we inherit code from.
The distinction is legal, not decorative: **busybox is GPLv2-only**, so any code
copied from it would relicense this whole project. We therefore take behaviour
from busybox and nvi, never source.

| Project | License | How we use it |
|---|---|---|
| [**busybox**](https://git.busybox.net/busybox) — `editors/vi.c` | **GPLv2 only** | **Specification only.** No code copied, no code translated line-by-line. We read it to learn *what* the command does and *which* cases matter, then implement in JavaScript from the behaviour. |
| [**nvi** / nvi2](https://github.com/lichray/nvi2) — Berkeley vi | BSD-3-clause | **Reference only.** Used to settle what traditional vi does where busybox and Vim disagree (`#`, `S`, `C`/`D`/`Y` aliasing, marks, `:s` scope). No code copied. |
| [**Input Vim**](https://github.com/matheuskieling/vim-input) — Matheus Kieling | MIT | **Code inherited.** The extension harness and the text↔host adapters derive from this project. The MIT notice is preserved in `NOTICE`. |
| [**TextEditAid**](https://github.com/WayneD/TextEditAid) — Wayne Davison | "freely used however you wish" | **Protocol only.** The `:e` escape hatch speaks a compatible wire shape so an existing `edit-server.py` works unchanged. No code copied. |

## The boundary, concretely

### Inherited from Input Vim (MIT) — keeping the copyright notice

Not rewritten, because it encodes hard-won knowledge about six hosts:

- key interception and the mode plumbing *around* the engine (`event-interceptor`,
  focus management, Escape fallback)
- the mode badge / caret overlay and the prompt line
- the `/ ?` and `:` prompt interaction shape
- the page bridge for framework editors
- the text↔host mapping primitives in the two DOM adapters (block walking, flat
  offset ⇄ DOM range conversion, selection save/restore, the CKEditor bridge)
- the injection seams themselves (workbench.html tag, Lark asar rewrite, OpenCode
  main-process `executeJavaScript`, extension-webview payloads)

### Built from scratch — nothing copied, nothing inherited

- **The engine.** Modes, key parser (counts, operators, pending character
  argument), buffer-line motions, operators, text objects, visual mode, marks,
  registers, `.` repeat, `U`, `R`, search, the `:` line and its 18 commands, the
  status line. Written against the behaviour documented in `docs/target-surface.md`.
- **The adapter contract.** `getBuffer`/`applyEdit`/`version`/`viewport`/
  `canEditExternally` — the interface is ours; upstream had no such boundary.
- **The regex wrapper** (`docs/regex-contract.md`): translate, refuse, or pass
  through. No POSIX emulation.
- **The external-editor session**: compare-and-swap return path, cursor
  round-trip, per-host transport selection.
- **The oracle harness** (`oracle/`): pty-driven differential testing against real
  `vim`, `nvi` and `busybox vi`.

### Deliberately *not* inherited

- `scratch-buffer.js` — deleted. A fake vim inside a fake vim; `:e` now launches a
  real editor.
- Upstream's display-line motion model — replaced with buffer-line semantics.
- Upstream's `Settings.halfPageJump` (a hardcoded 20) — replaced with a measured
  viewport.

## Thanks

To **Rob Landley, Erik Andersen and the busybox contributors**: your vi is the
best proof that a complete, precise vi fits in a few thousand lines, and reading
it is what made this project's scope arguable at all. `editors/vi.c` is the
single most useful document we read.

To **Keith Bostic, Sven Verdoolaege, Zhihao Yuan and the Berkeley nvi
maintainers**: nvi is the reference that settles arguments — strict traditional
vi, no Vim conveniences, every divergence measured rather than assumed.

To **Matheus Kieling** for Input Vim: it solved the unglamorous half of this
problem (getting a vim engine into editors that never expected one), and the
harness we inherit is a real piece of engineering.

To **Wayne Davison** for TextEditAid, which proved twenty years early that the
right way to edit a browser field is to hand it to a real editor and take it back
— and whose server protocol we simply adopted.
