# oracle — differential harness

Runs one keystroke sequence against several reference editors and compares the
result. Its job is to **pin down reference behaviour before the engine exists**, so
the engine is written against measurements rather than assumptions.

## Oracle of record

| Question | Decided by |
|---|---|
| Does this command exist? What does it take? | **busybox vi** (scope) |
| What exactly does it do? | **vim**, pinned options (behaviour) |
| Where busybox and Vim disagree, what does traditional vi do? | **nvi** (tiebreak) |

The three disagree often enough that divergence is recorded as a case rather than
hidden. Two examples already in `cases/basics.json`:

- **`S`** exists in vim and nvi; in busybox it is a commented-out stub.
- **`gg`** exists in busybox and vim; nvi is strict traditional vi and has no `gg`.

## Usage

```bash
python3 oracle/run.py                 # all engines, all cases
python3 oracle/run.py --engine vim -v # one engine, show buffers
python3 oracle/run.py oracle/cases/motions.json
```

Exit code is non-zero if any case fails. `SKIP` is not a failure — it means the
engine cannot observe what the case asserts (see below).

## What each engine can observe

| Engine | Buffer | Cursor | How |
|---|---|---|---|
| `vim` | ✅ | ✅ line + column | `-es` + an ex script, `:normal!` for the keys |
| `busybox` | ✅ | ❌ | pty: send keys, `:wq`, read the file |
| `nvi` | ✅ | ❌ | same |

So position assertions run only on vim. A case that asserts only a position is
**SKIP** on the pty engines rather than a false pass.

### Two harness traps, both hit for real

1. **`ex` mode starts on the *last* line** (ed heritage), not the first. Every case
   is therefore pinned with `call cursor(1,1)` before the keys, or the whole suite
   silently measures the wrong line. This produced two confident-looking wrong
   results before it was caught.
2. **`vim -u NONE` is *compatible* mode.** The harness always passes `-N`; the
   eventual editor launch must too.

### Third harness trap: `:normal!` silently truncates

A failing key (a beep) inside `execute "normal! ..."` **aborts the rest of the
sequence**, so `G$llx` ran as `G$ll` and `x` never happened - the case looked like
a product bug. Vim's `feedkeys(keys, "ntx")` keeps going after a beep, which is
what a human does. Both harnesses use `feedkeys` now; anything measured before
2026-11-12 through `:normal!` where a key could beep is suspect.

Known limits: vim's `col()` is a **byte** column while the engine will index by
code point, so non-ASCII fixtures need an explicit conversion before any column is
compared. Insert-mode typing is included in cases via `<Esc>`, but IME behaviour
is out of scope for the harness.

## Case schema

```json
{
  "name": "j moves one buffer line",
  "input": "one\ntwo\nthree\n",
  "keys": "jj",
  "expect": { "line": 3, "col": 1 }
}
```

- `keys` uses engine-neutral notation: `<Esc> <CR> <Tab> <BS>`, everything else
  literal.
- `expect` may contain `text`, `line`, `col`.
- `engines` restricts which engines run the case.
- `expect_by_engine` overrides per engine — used where the references genuinely
  diverge.

## Adding cases

Add to an existing file or drop a new `cases/*.json`. Prefer *behavioural* cases
over command-existence cases: the target surface already lists what exists, and
`docs/TARGET-SURFACE.md` carries the scope decisions.

When a case fails, the question to ask first is **"is the reference wrong, or is
my expectation wrong?"** — twice now it was the harness.
