# Contributing

Thanks for looking. This is a small, deliberately narrow project, and that is a design
decision rather than an accident — so this page exists to make the boundary visible
**before** you spend an evening writing code that we would decline. A good patch rejected
for scope is a bad outcome for everyone, and the fix is to talk about the surface first.

## What this project is

A **traditional-vi surface for browser text fields**: one textarea, input or rich composer
at a time, driven by the vi commands a hand already knows.

- **Busybox vi is the baseline, and that goal is complete.** All 88 in-scope commands are
  dispatched (`npm run audit` proves it). This is the floor, not the ambition.
- **A few Vim conveniences are included on purpose** — text objects, marks, registers, the
  system clipboard, screen-line motions, `.`/`U`/`R`, insert-mode `C-w`/`C-u` — because
  without them the editor is correct but tiring.
- **Not included, and not planned**: Vim script, plugins, ex mode, `:g`/`:v`, macros
  (`q`/`@`), numbered registers, `"=` (eval), block visual.

`docs/DECISIONS.md` is the register: what is in, what is out, and the reason for each. It is
the first place to look, and the first place a decision gets recorded.

## The one hard rule: scope is decided before code

**Please open an issue before writing a patch that adds a command, an option, a key
binding, a mode, or a host integration.** One paragraph is enough:

- what operation it makes possible, and how often a hand reaches for it;
- which reference editor it comes from (busybox / vim / nvi) and what that reference does
  in the corners;
- what it costs in *our* shape: new state, a new option, a new host capability, or just
  more of a rule that already exists.

If it is a bug in something we already implement, skip the proposal and send the fix.

**A declined proposal is a judgement about the surface, never about your work.** We will
say which of the criteria below it failed, and if the reason is "too expensive for its
value" we will offer the smaller version that we *would* take.

## How the decision is made

Three priorities, in this order:

1. **Muscle memory wins.** An operation performed without thinking must land exactly as the
   reference lands it. This is not a place to be creative or "close enough".
2. **A corner is kept when it falls out of the same primitive.** If faithful behaviour costs
   no new rule — the same word scan, the same edit, the same deletion — keep it. If it needs
   its own state machine, it is not free, whatever it looks like.
3. **Otherwise: document and drop.** The gap goes into `docs/ENGINE.md` with the mechanism
   it would have needed, so it stays a decision instead of becoming folklore.

And two standing constraints:

- **No new options unless nothing else works.** An option does not add a case to the test
  matrix, it *multiplies* it: every flag doubles the configurations that all the other
  features must also be tested under. The first option is cheap, the third is where a test
  suite stops being convincing. Prefer one fixed behaviour, even if it is not the one
  everybody would have chosen.
- **The browser is a constraint, not an inconvenience.** Insert mode belongs to the host;
  the caret, composition, the clipboard and the undo stack are not ours. A feature that
  needs to fight the host for any of those is usually the wrong feature.

## Always welcome, no proposal needed

- **Bugs in behaviour we claim to have**, with the browser/app, the field type, and the
  keystrokes.
- **Differential cases.** A case file that pins what a reference editor actually does is
  worth more than an argument, and `npm run gen:expect` writes the expectations from vim
  so they can be checked rather than typed.
- **Corrections to the docs**, especially where a claim in them does not match the code or
  the references. Several real bugs were found by noticing that a sentence was a lie.
- **Host reports.** "This composer eats `<C-r>`" or "this editor rewrites the DOM under us"
  is exactly the information this project runs on.
- **Performance and accessibility** in the overlays, the caret and the status line.

## If you do send a feature patch

It will be reviewed against this list, in order:

1. Does a reference editor implement it? (Which one, and what does *it* do in the corners?)
2. Is it one rule, or does it need new state? Can it reuse an existing primitive?
3. Does it add an option? If yes, expect pushback.
4. Is it measured? A differential case against the reference, not a hand-written
   expectation.
5. Does it fit the host model — no fighting the caret, the IME, or the host's undo?

Small, tested and boring is the sweet spot. Two behaviours in one pull request is usually
one too many: we would rather merge the first and discuss the second.

## Working on the code

`README.md` has the commands (`npm test`, `npm run test:e2e`, `npm run test:ce`,
`npm run test:oracle`, `npm run coverage`). Two conventions matter more than they look:

- **Expectations are generated from the reference, never typed.** See `tools/gen-expect.mjs`.
- **Validate the instrument before believing it.** `oracle/README.md` lists the harness
  traps that have already cost real time — including one that made an entire class of cases
  measure "nothing happened".

If a test fails, the first question is *"is the reference wrong, or is my expectation
wrong?"* — twice it has been the harness.

## License

Contributions are accepted under the MIT license (see `LICENSE`). The reference-editor
boundary in `CREDITS.md` matters: busybox is GPLv2-only, so it is a **specification** we
read, never code we copy; nvi (BSD-3) and Input Vim (MIT) are the ones whose code could be
carried across, with their notices intact.
