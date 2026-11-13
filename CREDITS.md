# Credits and inheritance boundary

Three projects inspired this, one is a specification, one we inherit code from.
The distinction is legal, not decorative: **busybox is GPLv2-only**, so any code
copied from it would relicense this whole project. We therefore take behaviour
from busybox and nvi, never source.

| Project | License (verified from the file) | How we use it |
|---|---|---|
| [**busybox**](https://git.busybox.net/busybox) — `editors/vi.c` | **GPLv2 only** — `LICENSE`: *"distributed under version 2 of the General Public License … Version 2 is the only version of this license which [applies]"* | **Specification only.** No code copied, no line-by-line translation. Read to learn *what* each command does and which cases matter, then implemented in JavaScript from the behaviour. |
| [**nvi** / nvi2](https://github.com/lichray/nvi2) — Berkeley vi | **BSD-3-clause** — `LICENSE`: Regents of the University of California / Bostic / Verdoolaege / Yuan, 3 clauses, no advertising clause | **Reference only.** Settles what traditional vi does where busybox and Vim disagree (`#`, `S`, `C`/`D`/`Y` aliasing, marks, `:s` scope). No code copied. |
| [**Input Vim**](https://github.com/matheuskieling/vim-input) — Matheus Kieling | **MIT** — declared in `README.md` under `## License`; upstream ships **no** `LICENSE` file | **Code inherited.** The extension harness and the text↔host adapters derive from this project. The MIT notice is preserved in `NOTICE`. |
| **pyTextFilter** ([`~/workspace/pytextfilter`] — Lifu Tang) | **Apache-2.0** — `LICENSE.txt`: *"Apache License, Version 2.0, January 2004"*, 202 lines, **no `NOTICE` file** | **Protocol reference.** The `:e` escape hatch speaks *its* wire shape (raw body in, edited body out, `x-url`/`x-id`, `X-File-Changed`), so an existing pyTextFilter server works unchanged. **No code copied.** |
| [**TextEditAid**](https://github.com/WayneD/TextEditAid) — Wayne Davison | No SPDX identifier — `COPYING.md`: *"The source code here can be freely used however you wish."* (GitHub reports `NOASSERTION`) | **Lineage only.** The original browser→local-editor idea this family descends from. No code copied. |

### Why the licences do not constrain the design

* **Busybox is the only one that would force a change**: GPLv2-only means any
  copied code relicenses this project. We take behaviour, never source, so this
  repository stays MIT.
* **pyTextFilter is Apache-2.0**, which is permissive and compatible with MIT. We
  copy no code, so today the obligation is credit only. If a snippet were ever
  reused, Apache-2.0 would additionally require the licence text, a prominent
  notice of modification, the `NOTICE` file if one exists (upstream has none),
  and the patent grant comes with it.
* **Input Vim is MIT**, and we *do* inherit code, so its copyright notice stays in
  `NOTICE` and the derived files carry an SPDX header.
* **nvi is BSD-3**: attribution only, and we copy nothing.

## The boundary, concretely

### Inherited from Input Vim (MIT) — keeping the copyright notice

Not rewritten, because it encodes hard-won knowledge about six hosts:

- key interception and the mode plumbing *around* the engine (`event-interceptor`,
  focus management, Escape fallback)
- caret ownership: which keys belong to the engine and which to the host, the
  mouseup → visual adoption, `getMouseSelection`'s anchor/head mapping (including
  the backward direction) and `clampCursorToLine` (`cursor-controller.js`,
  `handlers/input-handler.js`)
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
right way to edit a browser field is to hand it to a real editor and take it back.

And to **pyTextFilter**, the descendant that is actually still alive: the `:e`
transport is wire-compatible with it, which is why a server that has been editing
remote files over SSH for years also serves a browser field with no changes.
