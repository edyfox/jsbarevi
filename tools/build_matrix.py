#!/usr/bin/env python3
"""Build the three-way feature matrix: nvi2 vs busybox vi vs Input Vim.

Every support column is derived from source (parse functions below), not from
recall. Only the Verdict column carries judgement, and it is written out
explicitly in VERDICTS so each decision is auditable and easy to overturn.
"""
import os
import re
from pathlib import Path

# Checkouts of the reference projects (nvi2, busybox). Not vendored here: point the
# variable at wherever you cloned them.
REPOS = Path(os.environ.get("JSBAREVI_REPOS", Path.home() / "src"))
OUT = Path(__file__).resolve().parent

# --------------------------------------------------------------------------- nvi
def label(byte):
    if byte == 32:
        return " "
    if byte == 127:
        return "^?"
    if byte < 32:
        return "^" + chr(byte + 64)
    return chr(byte)


HEADER = re.compile(r"^/\* (\d{3}) +(.*?) \*/\s*$")


def nvi_table():
    """Line-based: a new entry begins at each `/* NNN  key */` comment line."""
    src = (REPOS / "nvi2/vi/v_cmd.c").read_text(errors="replace")
    body = src[src.index("VIKEYS const vikeys"):]
    entries, cur = [], None
    for line in body.splitlines():
        h = HEADER.match(line)
        if h:
            cur = {"num": int(h.group(1), 8), "lines": []}  # comments are octal
            entries.append(cur)
        elif cur is not None:
            if line.startswith("};"):
                break
            cur["lines"].append(line)
    out = {}
    for e in entries:
        if e["num"] == 0:
            continue
        block = "\n".join(e["lines"])
        func = re.search(r"\{\s*(NULL|[A-Za-z_]\w*)\s*,", block)
        strs = [m.group(1).replace('\\"', '"')
                for m in re.finditer(r'"((?:[^"\\]|\\.)*)"', block)]
        out[chr(e["num"])] = {
            "impl": bool(func) and func.group(1) != "NULL",
            "usage": strs[0] if strs else "",
            "desc": strs[1] if len(strs) > 1 else (strs[0] if strs else ""),
        }
    return out


# ---------------------------------------------------------------------- busybox
def busybox_table():
    """ACTIVE case labels only.

    busybox documents its *unimplemented* keys as commented-out `//case 'x':`
    lines inside the same switch (vi.c:3775-3792). Counting those as support
    inflates the surface by 18 keys and is wrong: they fall through to
    `default: not_implemented()`. Feature-gated cases are recorded separately.
    """
    src = (REPOS / "busybox/editors/vi.c").read_text(errors="replace")
    start = src.index("static void do_cmd(int c)")
    end = src.index("// NB!  the CRASHME code is unmaintained", start)
    out, gated = {}, set()
    for line in src[start:end].splitlines():
        if re.match(r"\s*//", line):
            continue
        m = re.match(r"\s*case\s+'((?:[^'\\]|\\.)*)':\s*(//[^\n]*)?", line)
        if m:
            raw, comment = m.group(1), (m.group(2) or "")
            ch = raw.replace("\\\\", "\\").replace("\\'", "'")
        else:
            n = re.match(r"\s*case\s+(\d+):\s*(//[^\n]*)?", line)
            if not n or not 1 <= int(n.group(1)) <= 31:
                continue
            ch, comment = chr(int(n.group(1))), (n.group(2) or "")
        if ch in "123456789":
            ch = "\x00count"
        comment = comment.lstrip("/").strip()
        comment = re.sub(r"^.-\s*", "", comment)
        out.setdefault(ch, comment)
    # marks/registers are behind ENABLE_FEATURE_VI_YANKMARK, undo behind _VI_UNDO
    for key in ('"', "m", "'", "u", "U"):
        if key in out:
            gated.add(key)
    return out, gated


# -------------------------------------------------------------------- Input Vim
# Source: key-parser.js (MOTION_KEYS/OPERATOR_KEYS/INSERT_KEYS/TEXT_OBJ_KEYS),
# vim-engine.js (VISUAL_OPS + key compares), both handlers. Regenerate with
# extract.py; this map is the curated normal-mode surface, annotated where the
# support is partial.
IV = {
    "h": "motion", "j": "motion", "k": "motion", "l": "motion",
    "w": "motion", "b": "motion", "e": "motion",
    "W": "motion", "B": "motion", "E": "motion",
    "0": "motion", "$": "motion", "^": "motion", "G": "motion", "g": "motion",
    "{": "motion", "}": "motion",
    "n": "motion", "N": "motion", "*": "motion", "#": "motion",
    "f": "motion", "F": "motion", "t": "motion", "T": "motion",
    ";": "motion", ",": "motion",
    "d": "operator", "c": "operator", "y": "operator",
    "i": "insert", "a": "insert", "I": "insert", "A": "insert",
    "o": "insert", "O": "insert",
    "r": "edit", "s": "edit", "x": "edit", "X": "edit",
    "C": "edit", "D": "edit", "Y": "edit",
    "p": "put", "P": "put",
    "u": "undo (native history)",
    "/": "search prompt (event-interceptor)",
    "?": "search prompt (event-interceptor)",
    "v": "visual char", "V": "visual line",
    "S": "visual only",
}

# ----------------------------------------------------------------------- verdict
# have   already in Input Vim, both references have it too
# have*  already in Input Vim, reference lineage is Vim/partial
# add    in at least both references, missing from Input Vim, useful in a field
# add?   worth having but carries extra work (prompt UI / state)
# drop:screen   viewport/terminal concept — no meaning in a page field
# drop:host     host app owns it (files, tabs, tags, suspend, status)
# drop:cut      deliberately cut by Edward's minimalism spec
# drop:ex       ex command / shell; covered by the escape hatch
# drop:ref      only one reference has it and it is not worth the surface
COUNT = "\x00count"
IV[COUNT] = "counts"

VERDICTS = {
    # --- cursor: characters and lines
    "h": "have", "l": "have", "j": "have", "k": "have",
    " ": "add", "+": "add", "-": "add", "_": "add",
    "\r": "add", "\n": "add", "\x0e": "add", "\x10": "add", "\x08": "add",
    "0": "have", "$": "have", "^": "have", "|": "add",
    # --- cursor: words
    "w": "have", "b": "have", "e": "have",
    "W": "have", "B": "have", "E": "have",
    # --- cursor: paragraphs, sentences, sections
    "{": "have", "}": "have", "(": "add", ")": "add",
    "[": "drop:ref", "]": "drop:ref",
    # --- cursor: target / search
    "f": "have", "F": "have", "t": "have", "T": "have",
    ";": "have", ",": "have", "%": "add",
    "\x01": "have*",  # nvi: search cursor word — IV covers the same need with *
    "/": "have", "?": "have", "n": "have", "N": "have",
    "*": "have*", "#": "have",
    # --- marks
    "m": "add", "'": "add", "`": "add",   # cost rule 2026-11-12
    # --- screen / scroll
    "H": "drop:screen", "M": "drop:screen", "L": "drop:screen", "z": "drop:screen",
    "\x02": "drop:screen", "\x04": "drop:screen", "\x05": "drop:screen",
    "\x06": "drop:screen", "\x15": "drop:screen", "\x19": "drop:screen",
    # --- insert / replace entry
    "i": "have", "a": "have", "I": "have", "A": "have",
    "o": "have", "O": "have", "R": "add",
    # --- delete / change / yank
    "d": "have", "c": "have", "y": "have",
    "x": "have", "X": "have", "s": "have", "S": "add",
    "D": "have", "C": "have", "Y": "have",
    # --- put
    "p": "have", "P": "have",
    # --- repeat / undo
    ".": "add", "u": "have", "U": "add",
    # --- join / case / indent / filter
    "J": "add", "~": "add", "<": "add", ">": "add",
    "!": "drop:ex", "=": "drop:ref", "&": "drop:ex",
    # --- visual
    "v": "have*", "V": "have*", "\x16": "drop:cut",
    # --- registers / macros
    '"': "add", "@": "drop:cut",           # registers cheap; macro needs a replay loop
    # --- ex / mode / file / tag / misc
    ":": "drop:ex", "Q": "drop:ex", "\x1c": "drop:ex",
    "Z": "drop:host", "\x1a": "drop:host", "\x07": "drop:host",
    "\x17": "drop:host", "\x14": "drop:host", "\x1d": "drop:host",
    "\x0c": "drop:screen", "\x12": "drop:screen",
    "\x03": "drop:host", "\x1b": "drop:host", "K": "drop:host",
    # --- counts
    "\x00count": "have",
}

FAMILIES = [
    ("Cursor — characters and lines",
     ["h", "l", "j", "k", "\x08", "\n", "\x0e", "\x10", " ", "+", "-", "_",
      "\r", "0", "$", "^", "|"]),
    ("Cursor — words", ["w", "b", "e", "W", "B", "E"]),
    ("Cursor — paragraphs, sentences, sections",
     ["{", "}", "(", ")", "[", "]"]),
    ("Cursor — targets, jumps and search",
     ["f", "F", "t", "T", ";", ",", "%", "/", "?", "n", "N", "*", "#", "\x01",
      "G", "g"]),
    ("Marks", ["m", "'", "`"]),
    ("Screen and scrolling",
     ["H", "M", "L", "z", "\x02", "\x04", "\x05", "\x06", "\x15", "\x19", "\x0c", "\x12"]),
    ("Insert and replace entry", ["i", "a", "I", "A", "o", "O", "R"]),
    ("Delete / change / yank / replace char",
     ["d", "c", "y", "x", "X", "s", "S", "D", "C", "Y", "r"]),
    ("Put", ["p", "P"]),
    ("Repeat and undo", [".", "u", "U"]),
    ("Join, case, indent, filter", ["J", "~", "<", ">", "!", "=", "&"]),
    ("Visual mode", ["v", "V", "\x16"]),
    ("Registers and macros", ['"', "@"]),
    ("Ex mode, files, tags, host",
     [":", "Q", "\x1c", "Z", "\x1a", "\x07", "\x17", "\x14", "\x1d", "K"]),
    ("Numeric prefixes", ["\x00count"]),
]

VERDICT_LABEL = {
    "have": "**have**",
    "have*": "have (Vim-lineage)",
    "add": "**ADD**",
    "add?": "ADD (needs prompt UI)",
    "drop:screen": "drop — screen",
    "drop:host": "drop — host owns it",
    "drop:cut": "drop — your cut list",
    "drop:ex": "drop — `:` / shell",
    "drop:ref": "drop — single ref",
}

FALLBACK_DESC = {
    "h": "move left", "l": "move right", "j": "move down", "k": "move up",
    "\x08": "move left (alias of h)", "\n": "move down (alias of j)",
    "\x0e": "move down (alias of j)", "\x10": "move up (alias of k)",
    " ": "move right (alias of l)", "+": "down to first non-blank",
    "-": "up to first non-blank", "_": "first non-blank of current line",
    "\r": "down to first non-blank (alias of +)",
    "0": "start of line", "$": "end of line", "^": "first non-blank", "|": "column",
    "w": "next word", "b": "back word", "e": "end of word",
    "W": "next bigword", "B": "back bigword", "E": "end of bigword",
    "{": "back paragraph", "}": "forward paragraph",
    "(": "back sentence", ")": "forward sentence",
    "[": "back section (C source)", "]": "forward section (C source)",
    "f": "find char forward", "F": "find char back",
    "t": "till char forward", "T": "till char back",
    ";": "repeat find", ",": "repeat find reversed", "%": "match bracket",
    "/": "search forward", "?": "search back", "n": "next match", "N": "prev match",
    "*": "search cursor word", "#": "search cursor word back",
    "\x01": "search cursor word forward (nvi)",
    "m": "set mark", "'": "goto mark (first non-blank)", "`": "goto mark (exact)",
    "H": "screen top (count = nth from top)", "M": "screen middle",
    "L": "screen bottom (count = nth from bottom)",
    "z": "reposition: zt/zz/zb put the cursor line at top/middle/bottom",
    "\x02": "page up", "\x04": "half page down (count becomes the scroll size)",
    "\x05": "scroll down a line", "\x06": "page down",
    "\x15": "half page up", "\x19": "scroll up a line", "\x0c": "redraw", "\x12": "redraw",
    "i": "insert before cursor", "a": "append after cursor",
    "I": "insert at first non-blank", "A": "append at end of line",
    "o": "open line below", "O": "open line above", "R": "replace mode",
    "d": "delete operator", "c": "change operator", "y": "yank operator",
    "x": "delete char", "X": "delete char before cursor",
    "s": "substitute char", "S": "substitute whole line",
    "D": "delete to end of line", "C": "change to end of line",
    "Y": "yank whole line",
    "p": "put after", "P": "put before",
    ".": "repeat last change", "u": "undo", "U": "restore whole line",
    "J": "join lines", "~": "flip case", "<": "shift left", ">": "shift right",
    "!": "filter through command", "=": "auto-indent", "&": "repeat substitute",
    "v": "visual (char)", "V": "visual (line)", "\x16": "visual (block)",
    '"': "select register", "@": "execute buffer (macro)",
    ":": "ex command", "Q": "ex mode", "\x1c": "ex mode",
    "Z": "write and exit", "\x1a": "suspend", "\x07": "file status",
    "\x17": "next screen", "\x14": "tag pop", "\x1d": "tag push",
    "K": "keyword lookup", "\x00count": "numeric prefix",
}

NOTES = {
    "\x01": "IV's `*` covers the same need; no separate key required",
    "/": "busybox: active (vi.c:4037) — pattern read via get_input_line() on the status line; empty pattern re-uses the last one and flips direction; search wraps. ALSO an operator target (find_range() accepts nN/? as MULTI, vi.c:3590) so `d/foo` is in the baseline. IV: prompt exists in event-interceptor.js but its Enter path dispatches a bare MOTION, so the operator case needs work.",
    "?": "same as `/`, backwards; busybox:4063",
    "S": "IV has S only inside visual mode, not as a normal-mode command",
    "R": "both refs; needs overlapping-replace bookkeeping",
    "U": "both refs; needs a per-line snapshot",
    ".": "in both refs; the highest-value single addition",
    "%": "both refs; pure buffer scan",
    "#": "SEMANTICS DIFFER: nvi increments a number, IV searches back (Vim)",
    "*": "neither ref has it (busybox's `*` is a commented stub; nvi uses ^A for the same job)",
    "v": "NEITHER reference has it: nvi has no visual mode, and busybox's v/V are commented-out stubs",
    "V": "same: Vim-lineage only",
    "\x16": "cut by spec (no block visual); nvi has none, busybox has none",
    '"': "busybox: `char *reg[28]` + a-z select (~20 lines). Cheap => IN. One real trap: the SYSTEM clipboard in a browser is async and permission-gated, so registers live in-engine first (synchronous, testable); clipboard mirroring is a later, separate feature",
    "@": "nvi only — busybox's `@` is a commented stub, so macro stays out either way",
    "m": "busybox: `mark[26]` offsets + a validity guard on use (~20 lines). Cheap => IN. Per-field, invalidated when the field is replaced",
    "(": "nvi-only, but a pure buffer scan (~20 lines) — the same cost class as marks, so arguably IN under the cost rule",
    ")": "same as `(`",
    "=": "busybox only; auto-indent belongs to the host editor",
    "[": "nvi only (the busybox `[` case is a motion stub)",
    "]": "nvi only",
    "K": "busybox only; needs an external `man`-style lookup program",
    "\x07": "IN by the cost rule. No file, so report the URL-analogue: [Modified] line N of M - col C - K chars (nvi msgq_status shape minus the filename). Needs one shared status-line primitive, which also serves :set print, :version, :features, :list and :file - six surfaces, one capability",
    "\x04": "IV today: NOT a scroll — _doScrollJump moves the CURSOR by Settings.halfPageJump (hardcoded 20) lines; ^F/^B absent entirely",
    "\x15": "same defect, upwards",
    "\x06": "absent from Input Vim (only d/u are intercepted)",
    "\x02": "absent from Input Vim",
    "H": "absent from Input Vim; becomes nearly free once the viewport capability exists",
    "M": "absent from Input Vim",
    "L": "absent from Input Vim",
    "`": "nvi-only, ~5 lines once marks exist: same store, exact position instead of first-non-blank => IN",
    "^N": "nvi alias of j, ~2 lines => IN",
    "^P": "nvi alias of k, ~2 lines => IN",
    "_": "== `^` (first non-blank), ~2 lines => IN",
    ")": "pure buffer scan ~20 lines; prose sentence ends = . ! ? + blank line => IN",
    "[": "C-source section marker (`{` at col 0) — no referent in a chat box or a prose field",
    "]": "same as `[`",
    "@": "macro = register + command replay loop; the real cost is replaying counts/operators, not storing keys",
    "=": "not in busybox (stub); auto-indent belongs to the host editor",
    "&": "depends on `:s`, which depends on ex mode — out with it",
    "^A": "nvi's word search; `*` already covers the need",
}


EX_MODE = {"Q", "\\", "\x1c"}                      # persistent ex mode - explicitly out
# Reclassified 2026-11-12: these are not "host owns it", they need a VIEWPORT
# capability from the adapter. One capability unlocks all of them.
VIEWPORT = {"H", "M", "L", "z", "\x02", "\x04", "\x05", "\x06", "\x15", "\x19"}
HOST_OWNED = {"Z", "\x0c", "\x12", "\x1a", "\x17", "\x14", "\x1d"}
#           file lifecycle · redraw (browser repaints) · suspend · next screen · tags
STATUS_RULING = set()   # ^G resolved 2026-11-12: IN - the rule is cost, not usage
DECISION_NEEDED = set()  # resolved 2026-11-12: cost decides, not personal usage
                         # -> marks and the register select are baseline
BEYOND = {"v", "V", "*", "#"}               # IV has them, busybox does not
# nvi-only but trivial (a few lines each) -> IN under "cost decides", not taste.
TINY = {"`", "(", ")", "_", "\x0e", "\x10"}


def target(key):
    if key in EX_MODE:
        return "drop — ex mode"
    if key in VIEWPORT:
        return "**baseline — needs viewport capability**"
    if key in STATUS_RULING:
        return "ruling: repoint ^G at field status, or drop"
    if key in HOST_OWNED:
        return "drop — host owns it"
    if key in DECISION_NEEDED:
        return "**baseline, but conflicts with your cut list**"
    if key in BEYOND:
        return "beyond baseline — keep (Vim)"
    if key in TINY:
        return "baseline (nvi-only, trivial cost)"
    if key in bb_active:
        return "**baseline**"
    if key in IV:
        return "keep (already have, no baseline)"
    return "out"


def render(key):
    if key == COUNT:
        return "<count>"
    if key == " ":
        return "<space>"
    if len(key) == 1 and ord(key) < 32:
        return "^" + chr(ord(key) + 64)
    if len(key) == 1 and ord(key) == 127:
        return "^?"
    return key


def code(lbl):
    return f"`` {lbl} ``" if "`" in lbl else f"`{lbl}`"


def strip_echo(desc, key):
    """nvi writes the description as '<key> <text>'."""
    d = desc.lstrip()
    for token in (key, key.upper(), render(key)):
        if d.startswith(token):
            d = d[len(token):].lstrip(" :-")
            break
    return d


def iv_status(key):
    return IV.get(key)


def main():
    nvi = nvi_table()
    bb, bb_gated = busybox_table()
    globals()["bb_active"] = set(bb)
    # busybox handles CR via the 13 case; keep it


    lines = []
    add = have = drop = 0
    for family, keys in FAMILIES:
        rows = []
        for key in keys:
            n = nvi.get(key)
            nv = "—" if not n else ("✓" if n["impl"] else "null")
            b = bb.get(key)
            bv = "✓" if b is not None else "—"
            if key in bb_gated and b is not None:
                bv = "✓†"
            tgt = target(key)
            ivs = iv_status(key)
            ivv = "✓" if ivs else "—"
            desc = (n["desc"] if n and n["desc"] else "") or FALLBACK_DESC.get(key, "")
            desc = strip_echo(desc, key)
            desc = desc or FALLBACK_DESC.get(key, "")
            if len(desc) > 58:
                desc = desc[:56].rstrip() + "…"
            verdict = VERDICTS.get(key, "?")
            if verdict == "add" or verdict == "add?":
                add += 1
            elif verdict == "have" or verdict == "have*":
                have += 1
            else:
                drop += 1
            note = NOTES.get(key, "")
            if ivs and ivs.startswith("visual only") and verdict.startswith("add"):
                note = note or "today only inside visual mode"
            label = render(key)

            rows.append(
                f"| {code(label)} | {nv} | {bv} | {ivv} | {desc} | {VERDICT_LABEL.get(verdict, verdict)} | {tgt} | {note} |"
            )
        lines.append(f"\n### {family}\n")
        lines.append("| Key | nvi | bb | IV | Does | Delta verdict | **Target: busybox baseline** | Note |")
        lines.append("|---|---|---|---|---|---|---|---|")
        lines.extend(rows)

    # ---------------------------------------------------------------- ex commands
    exc = []
    src = (REPOS / "nvi2/ex/ex_cmd.c").read_text(errors="replace")
    body = src[src.index("EXCMDLIST const cmds[]"):]
    cur = None
    for line in body.splitlines():
        if re.match(r"^/\* C_[A-Z0-9_]+ \*/", line):
            cur = []
            exc.append(cur)
            continue
        if line.startswith("};"):
            break
        if cur is not None:
            cur.append(line)
    parsed = []
    for block in exc:
        b = "\n".join(block)
        name = re.search(r'L\("((?:[^"\\]|\\.)*)"\)', b)
        strs = [m.group(1).replace('\\"', '"')
                for m in re.finditer(r'"((?:[^"\\]|\\.)*)"', b)]
        if not name:
            continue
        nm = name.group(1).replace("\\004", "^D").replace("\\033", "ESC")
        usage = strs[1] if len(strs) > 1 else (strs[0] if strs else "")
        desc = strs[-1] if strs else ""
        parsed.append((nm, usage, desc))
    exc = parsed
    ex_rows = "\n".join(f"| `{n}` | {u or '—'} | {d} |" for n, u, d in exc)

    doc = f"""# Three-way feature matrix — nvi vs busybox vi vs Input Vim

Generated by `build_matrix.py` from source (regenerate after pulling either
repo). Support columns are parsed, not recalled. Only **Verdict** is judgement,
and it is written explicitly in the script so any decision can be overturned in
one place.

Reference revisions: nvi2 `02acac8` · busybox `4f986c0` · Input Vim fork
`e05e662`. Both references are also installed locally (`/usr/bin/nvi` 1.81.6,
`/usr/bin/busybox`), so every row can be measured with the oracle harness.

Legend: **✓** implemented · **null** in nvi's table with no handler (behaviour
needs measuring) · **✓†** implemented in busybox but behind a build flag
(`ENABLE_FEATURE_VI_YANKMARK` / `_VI_UNDO`) · **—** absent.

> **Data corrections (2026-11-12, twice).** busybox documents the commands it
> does *not* implement as commented-out `//case` lines inside `do_cmd()`, falling
> through to `default: not_implemented()`. Counted from source:
> **18 commented char labels + 15 commented numeric labels = 33 stubs**, and
> **89 active `case` labels** (76 char literals + 13 numeric control keys). Of
> those, 9 are digit-count labels and one is a NUL no-op, so the real command
> surface is ~78-80, not "76 keys".
>
> Not implemented at all: visual mode (`v`/`V`), `*`, `(` `)`, `_`, `[` `]`, `@`,
> `S`, `!` `#` `&` `=` `K` `Q` `\`, and the backtick mark.

Tally of the *delta* column (what Input Vim would gain): **{have} already
supported · {add} to add · {drop} dropped** ({len(FAMILIES)} families).
The **Target** column answers a different question — what we ship — under the
rule **"busybox is the baseline; cost decides, not personal usage"**
(Edward, 2026-11-12). A feature busybox implements simply is cheap enough to
carry even if nobody uses it daily; the cut list was about keeping the
implementation simple, never about taste.

Therefore a command may only be excluded for one of three reasons:

1. **No ex mode** — `Q`, `\` (persistent ex mode). `:` stays: it is one-shot and
   the escape hatch rides it.
2. **No referent in a single text field** — `H M L z Z`, scroll keys: screen
   geometry and file lifecycle belong to the host, not to us.
3. **Needs an external process** — `!` (shell filter), `K` (keyword program).

Cost was the fourth reason and it is now gone for anything busybox already does.
{"\n".join(lines)}

## Viewport motions — cost verdict (easy enough: do it properly)

**What Input Vim does today** (verified, not assumed):

- `^D` / `^U` are intercepted (`event-interceptor.js:632-637`) and dispatched as
  `SCROLL_DOWN` / `SCROLL_UP`, but `_doScrollJump()` (`input-handler.js:949`)
  **never touches the viewport**. It moves the *cursor* by
  `Settings.halfPageJump` lines — a hardcoded **20** (`settings-manager.js:16`),
  unrelated to how tall the field is.
- `^F` / `^B` are **not implemented at all** (only `d` and `u` are in that branch).
- `H` / `M` / `L` do not exist.

So the current behaviour is "cursor jumps 20 lines", which is neither a page nor
a half page, and the number is arbitrary. That is the "very poor way".

**What proper means** (vi semantics, boundary cases included):

| Key | Semantics | The fiddly part |
|---|---|---|
| `^F` / `^B` | scroll one screen, keep **2 lines of overlap** (`scroll` option), cursor to the first/last line of the new screen | at EOF/BOF it must stop scrolling and put the cursor on the last/first line instead |
| `^D` / `^U` | scroll **half a screen**; a count *sets* the scroll size and persists (vi behaviour) | half-screen = `floor(visibleLines/2)`, not a constant |
| `^E` / `^Y` | scroll one line, cursor follows when it would leave the screen | |
| `H` / `M` / `L` | cursor to the top/middle/bottom **visible** line; counts count inward (`3H`, `2L`) | needs the visible line range, then a mapping back to a text offset |
| `zt` / `zz` / `zb` | put the cursor's line at top/middle/bottom | same measurement, inverted |

**Verdict: easy enough — but only as an adapter capability.** Three
sub-problems, priced:

1. *Know the viewport* — `scrollTop`, `clientHeight`, and line height. For
   textarea/input this is arithmetic on `scrollTop / lineHeight`, and the
   existing `computeVisualLines()` machinery already gives wrap boundaries.
2. *Map visible line index ↔ text offset* — ~30 lines for textarea/input.
   Rich editors (ProseMirror/Slate) need `Range.getClientRects()` and their own
   scroll container: per-adapter, ~40 lines each.
3. *Set the viewport* — write `scrollTop`, then place the cursor.

Roughly **120 LOC in the core semantics + ~30 per simple adapter**, and it needs
layout to test, which is why the oracle harness cannot be jsdom-only (the existing
suite already runs 20 Chromium layout tests, so the pattern exists).

**The multiplier that makes this obviously worth it: one capability buys ten
commands** — `^B ^D ^E ^F ^U ^Y H M L z`. All ten were previously marked
"host owns it"; that verdict was wrong, they were "needs a viewport".

Three caveats to keep it honest:

- **Engine stays pure.** The adapter reports `{{scrollTop, clientHeight,
  lineHeight}}` (or `null`); when it reports `null`, these keys pass straight
  through to the host. No host, no wrong behaviour.
- **Drop the magic 20.** Half screen is measured; a count sets and remembers it.
- **Some hosts own the keys.** ProseMirror/Slate and Lark's editor handle
  `PageUp`/`PageDown` themselves; intercepting those needs the same "only if the
  adapter opted in" gate, or it will fight the host.

What genuinely belongs to the host now reduces to `Z` (file lifecycle) and
`^L`/`^R` (redraw — the browser repaints). `^G` is the one open ruling: repoint it
at a **field** status (line/char position, total lines) or drop it.

## Escape hatch — `:e` contract (scratch buffer dropped, 2026-11-12)

Upstream's `:e` opens `scratch-buffer.js`: a textarea overlay running the *same
fake-Vim engine*. That is a fake vim inside a fake vim, and it is the one place
where the codebase can end up with two engines handling the same keys — the exact
trap already recorded in the injection playbook ("two seams live at once = two
vim engines = double key handling").

**Decision: delete the scratch buffer; `:e` launches the real editor.**

| `:e` | Behaviour |
|---|---|
| `:e` | send `{{text, site, field, line, col}}` to the daemon; the request resolves when the editor exits; write the result back |
| `:e!` | same, but re-send the *current* field text (discard nothing, reload) |
| `:e <file>` | refuse — there is no file behind a page field |
| daemon unreachable | status line with the exact command to start it. Never a silent failure |
| host blocks loopback (`connect-src`) | degrade honestly: copy out to the clipboard, tell the user, they paste back. No pretence of automation |

**Most of the semantics come free** because the editor is real vim with a real
temp file — no custom vimscript needed:

| In the editor | Meaning for the field |
|---|---|
| `:wq` / `:x` | write the temp file, exit → **commit** the new text |
| `:q!` / `:cq` | exit without writing → **discard**, field untouched |
| `:q` | vim's own "no write since last change" guard, for free |

**Cursor round-trip**: send `+{{line}}:{{col}}` on the command line so the editor
opens where you were; on exit, a `VimLeavePre` autocmd writes `line('.')` and
`col('.')` to a sidecar file, so the caret comes back too.

**The one behaviour I'm choosing (revisit if you disagree):** the page can change
while vim is open — an autosave, a formatter, a send. On return we **compare and
swap**: if the field's text no longer matches what we sent, we do *not* clobber
it. The status line says *"field changed while editing — `:e` to reload, or
cancel"*. Cheap, and testable without a browser.

> **⚠ Transport under revision (2026-11-12 review).** Three findings break the
> "just POST to loopback" plan on real hosts:
> (a) a **content-script** fetch carries the *page's* Origin, not
> `chrome-extension://` — only a service-worker fetch carries the extension
> origin, which is why TextEditAid's own request works;
> (b) Chrome **terminates a service worker** whose `fetch()` has not returned
> within ~30 s, so a request held open for the whole editing session fails;
> (c) in the Electron payloads the page's `connect-src` blocks loopback in VS Code
> chat, the Cursor Agent window and Devin's sessions window (which does allow
> `ws:`), and a page-world payload cannot be handed a secret at daemon start.
> Candidate transports: native messaging (Chrome), a main-process channel
> (OpenCode), WebSocket (Devin sessions), clipboard as a first-class path
> everywhere else. **Decision pending.**

**Protocol: TextEditAid-compatible** (read from `WayneD/TextEditAid`,
`servers/edit-server.py`, 300 lines). The shared mechanism is exactly what we
want to keep, because it is dead simple:

| Wire element | TextEditAid | Ours |
|---|---|---|
| request | `POST` to a local URL, **raw body = the field's text** (not JSON) | same |
| response | raw bytes of the edited text, `text/plain` | same (+ cursor sidecar) |
| timing | the POST stays open until the editor exits | same |
| metadata | query string, `?url=<page url>` → temp filename only | same channel, also used for the status line and `^G` |
| temp file | `$TMPDIR`, prefix, `.txt`, `umask(077)` | `$XDG_RUNTIME_DIR`, `0600` |
| cleanup | delete temp files older than 4 h | same |
| health | `GET` returns a one-line "server is up" | same |
| auth | `Origin` must start with `chrome-extension:` **and** Basic auth saved on first use | `Origin: chrome-extension://<our-id>` where available; `X-Edit-Token` on the patched-Electron path, where the payload runs in page context and cannot produce that Origin |
| spawn | `EDITOR_CMD.replace('SAFE_ARG', shlex.quote(path))` + `shell=True` | **argv-only**, no shell |
| editor | `rgvim -f` (fork-and-wait) | `vim -u NONE -i NONE -n --cmd 'set nomodeline'` |

Two useful consequences:

1. **Their Origin check is better than the token I proposed** for the Chrome path —
   `Origin` is a forbidden header, so a web page cannot forge
   `chrome-extension://…`. The token is only needed for the patched-Electron
   payloads, which run in page context and have no extension origin.
2. **We can develop against their daemon before writing ours.** Our Chrome
   extension would send `Origin: chrome-extension://<our-id>`, which passes their
   check, so the two are interchangeable for testing — and a user could point
   our extension at an existing `edit-server.py`. Deliberate deviations from
   theirs: no shell, `nomodeline`, and `$XDG_RUNTIME_DIR`.

(Their auth model has one weak edge worth knowing: the *first* request that
arrives saves the Basic credential to `~/.edit-server-auth`, so it is
first-writer-wins. The Origin check is what actually keeps pages out; our token
is generated fresh at daemon start instead of being pinned by a stranger.)

**Security contract for the daemon** (restating what the design must carry):

- bind `127.0.0.1` only; validate `Host`; require `X-Edit-Token` and refuse
  preflights from unknown origins (a page cannot set a custom header cross-origin)
- single-use nonce per `/edit`, short TTL, one session at a time, session timeout
- argv-only spawn, never a shell; text only ever via a `0600` temp file under
  `$XDG_RUNTIME_DIR`
- launch as `vim -N -u NONE -i NONE -n --cmd 'set nomodeline'` — **`-N` is
  mandatory**: `vim -u NONE` alone starts in *compatible* mode (verified locally),
  which disables most of what we want. `--cmd 'set nomodeline'` closes the
  documented "opening the file is already execution" vector
- log every request with its origin, so an attempt is visible after the fact

## Motion model — the `j`/`k` defect (and it is wider than j/k)

Input Vim's line motions are **display-line** motions, not buffer-line motions.
`resolveMotion()` takes a `vLines` argument and, whenever it is present, every
line-oriented motion uses rendered wrap boundaries:

| Key | Input Vim behaviour today | Authentic vi |
|---|---|---|
| `j` / `k` | `gj` / `gk` — one *rendered* line | one *buffer* line (`\n`) |
| `h` / `l` | clamp to the visual-line ends (`motion-resolver.js:261-289`) | clamp to the real line ends; `l` never wraps |
| `0` / `$` / `^` | visual-line start / end / first non-blank (`:354-390`) | same, on buffer lines |

Evidence: `handlers/input-handler.js:94` builds the lines by canvas measurement
(`computeVisualLines(el.value, ctx, contentWidth)`), `:250` passes them into
every motion, and `:258` even derives the remembered column as
`pos - vLines[vi].start` — i.e. the *display* column, not the buffer column. The
resolver's own comments call these branches "FIX"es, so this was deliberate:
it makes a wrapped chatbox feel natural and it is wrong for anyone with vi
muscle memory.

**What the fix means structurally**

1. `resolveMotion()` must not accept `vLines` for motion. Buffer lines are
   `text.split("\n")` — the same logical snapshot the adapters already build.
2. `desiredCol` becomes the buffer column, clamped per line (vi's
   "column memory" rule: `10j` then `k` returns to column 10).
3. `vLines` survives **only** for cursor/overlay rendering, and for an optional
   future `gj`/`gk`.
4. Consequence to accept knowingly: in a long wrapped prompt, `j` skips the
   whole paragraph. That is what vi does, and it is the behaviour you asked for.

## Ex commands (`:`)

nvi ships **{len(exc)}** ex commands; busybox implements **18**
(`! = delete edit features file list next prev quit read rewind s set version
write x yank`); Input Vim implements **6**, in `executeCmdLine()`
(`event-interceptor.js:443`): `:e` `:w` `:wq` `:q` `:q!` `:x`.

**Ruling (2026-11-12): support exactly what busybox supports.** Same cost
principle as the vi-mode commands. What busybox's `colon()` actually accepts,
read from source (`editors/vi.c:2798-3460`):

- **18 commands**: `delete` `edit` `file` `features` `list` `quit` `next`
  `prev` `read` `rewind` `set` `version` `write` `yank` `s` `x` `=` `!`
- **addresses and ranges**: line numbers, `.`, `$`, `%`, `/pat/`, `?pat?`,
  `'x` marks, `,` and `;` separators, a count
- **a `!` force suffix** on the file commands

Matching is **by prefix** (`strncmp(cmd, "word", cmdlen)`), so `:d`, `:e`, `:w`,
`:q`, `:se`, `:ver` all work — we should match that rather than demand full
names.

Reality check: 8 of the 18 are file- or process-oriented, and a browser field
has no file and no shell. So the same three exclusion grounds apply.

| busybox command | In a page field | Disposition |
|---|---|---|
| `s` substitute — takes **line ranges**, pattern matched **within a line**, `ignorecase` honoured, `g` reads only its first flag character, **JS regex** | fully applicable | **implement** (~150 lines, see regex policy) |
| `delete` / `d` (+ ranges) | applicable | implement |
| `yank` / `y` (+ ranges) | applicable | implement |
| `=` show line number | applicable | implement |
| `list` literal print (`$` at EOL) | applicable | implement |
| `set` — `autoindent`, `expandtab`, `err_method` (printed to users as **`flash`**), `ignorecase`, `showmatch`, each with a `no` prefix, **plus numeric `tabstop`/`ts`** | applicable, and `expandtab`/`ignorecase`/`autoindent`/`ts` genuinely matter to us | implement (~60 lines) |
| `version` / `features` | applicable | implement (ours report ours) |
| `edit` / `e` | no file — but this is the escape hatch | **repoint**: hand the buffer to the real editor |
| `write` / `w` / `wq` / `x` | no file | **repoint**: commit the editor session |
| `quit` / `q` / `q!` | no file | **repoint**: close / discard the editor session |
| `read` / `r` | no file to read | refuse with a clear message |
| `next` / `n`, `prev`, `rewind` | no file list | refuse |
| `file` | no filename — but `^G` now reports field identity | **repoint**: same status primitive as `^G`, so the two cannot drift apart |
| `!` shell filter | **no shell in a page** — and it is the RCE we designed against | refuse in-page; daemon-only if ever |

**Regex policy (ruled 2026-11-12): use JS `RegExp`. Do not implement a POSIX
translator.** One engine serves both `:s` and `/ ?`; `ignorecase` maps to the `i`
flag. Emulating POSIX BRE is not worth the code, and the user is told what
differs. The deviations, documented in the help for `:s` and `/`:

| Construct | busybox / POSIX | Ours (JS) | Handling |
|---|---|---|---|
| alternation `a\|b` | BRE needs `\(a\|b\)`; alternation is **leftmost-longest** | `(a\|b)`; **leftmost-first** | document — `a\|ab` on `ab` picks `a` for us, `ab` for POSIX |
| POSIX classes `[[:space:]]` etc. | supported | **not supported** (silently never matches) | **refuse with a precise message** naming the construct and the JS equivalent (`\s`), never a silent non-match |
| word boundaries `\<` `\>` | supported | use `\b` | map them, it is exact |
| replacement `&` | literal in busybox, whole match in vim | whole match (`$&`) | follow **vim**: `&` and `\0`–`\9` expand, via a replacer function |
| empty pattern `:s//x/` | reuses the last pattern | same | keep |

Busybox itself is not a clean reference here: its regex is a build option
(`vi.c:78-80`), so a plain build does literal matching; and its `g` flag reads
only the first flag character. We follow **vim** for replacement syntax and flags,
**JS** for matching power, and we refuse rather than mis-match.

| nvi ex command | Usage | Description |
|---|---|---|
{ex_rows}
"""
    (OUT / "THREE-WAY-MATRIX.md").write_text(doc, encoding="utf-8")
    tally = {}
    for fam, keys in FAMILIES:
        for k in keys:
            tally[target(k)] = tally.get(target(k), 0) + 1
    print("\nTarget tally:")
    for k, v in sorted(tally.items(), key=lambda kv: -kv[1]):
        print(f"  {v:3d}  {k}")
    print(f"have={have} add={add} drop={drop} ex={len(exc)}")
    print(f"wrote {OUT / 'THREE-WAY-MATRIX.md'}")


if __name__ == "__main__":
    main()
