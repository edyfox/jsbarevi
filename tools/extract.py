#!/usr/bin/env python3
"""Extract the reference command inventories from nvi2 and busybox sources.

Source-derived only: nothing here is recalled from memory. Output is plain
text lists consumed by the feature-matrix document.
"""
import re
import subprocess
from pathlib import Path

REPOS = Path.home() / "workspace/collectx-monorepo/_repos"
OUT = Path.home() / "workspace/collectx-monorepo/_local/scratchpad/ext-injection/vi-minimal-2026-11-12"
OUT.mkdir(parents=True, exist_ok=True)


def read(p):
    return p.read_text(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------- nvi2 vi keys
def nvi_vikeys():
    src = read(REPOS / "nvi2/vi/v_cmd.c")
    start = src.index("VIKEYS const vikeys")
    end = src.index("\n};", start)
    body = src[start:end]
    # Each entry: {/* comment */} {func, flags, "usage", "description"},
    entries = []
    for m in re.finditer(
        r'\{\s*(NULL|[A-Za-z_][\w]*)\s*,\s*([^,]*),\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\}',
        body,
        re.S,
    ):
        func, flags, usage, desc = m.groups()
        entries.append(
            {
                "func": func.strip(),
                "flags": " ".join(flags.split()),
                "usage": usage.replace('\\"', '"'),
                "desc": desc.replace('\\"', '"'),
                "defined": func.strip() != "NULL",
            }
        )
    return entries


# ------------------------------------------------------------- nvi2 ex commands
def nvi_excmds():
    src = read(REPOS / "nvi2/ex/ex_cmd.c")
    start = src.index("EXCMDLIST const cmds[]")
    end = src.index("\n};", start)
    body = src[start:end]
    entries = []
    for m in re.finditer(
        r'\{\s*L\("((?:[^"\\]|\\.)*)"\)\s*,\s*([A-Za-z_][\w]*)\s*,\s*([^,]*),\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\}',
        body,
        re.S,
    ):
        name, func, flags, alias, usage, desc = m.groups()
        entries.append(
            {
                "name": name.replace("\\004", "^D").replace("\\033", "ESC"),
                "func": func,
                "flags": " ".join(flags.split()),
                "usage": usage.replace('\\"', '"'),
                "desc": desc.replace('\\"', '"'),
            }
        )
    return entries


# ------------------------------------------------------------------- busybox vi
def busybox_vicmds():
    src = read(REPOS / "busybox/editors/vi.c")
    start = src.index("static void do_cmd(int c)")
    end = src.index("// NB!  the CRASHME code is unmaintained", start)
    body = src[start:end]
    out = []
    for m in re.finditer(r"case\s+'((?:[^'\\]|\\.)*)':", body):
        ch = m.group(1)
        # grab the tail of the line for an inline comment, if any
        line_end = body.find("\n", m.end())
        tail = body[m.end() : line_end].strip()
        out.append({"key": ch, "tail": tail[:90]})
    return out


def busybox_excmds():
    src = read(REPOS / "busybox/editors/vi.c")
    # ex command dispatcher: ex_cmd()
    try:
        start = src.index("static void colon(char *buf)")
    except ValueError:
        return []
    end = src.index("static int st_test(char *p, int type, int dir, char *tested)")
    body = src[start:end]
    names = {m.group(1) for m in re.finditer(r'strncmp\(cmd, "(\w+)"', body)}
    names |= {m.group(1) for m in re.finditer(r"cmd\[0\] == '(.)'", body)}
    return sorted(names)


# -------------------------------------------------------------- Input Vim tables
def inputvim_tables():
    kp = read(REPOS / "vim-input/content/key-parser.js")
    enginesrc = read(REPOS / "vim-input/content/vim-engine.js")
    handlers = read(REPOS / "vim-input/content/handlers/input-handler.js")
    ce = read(REPOS / "vim-input/content/handlers/contenteditable-handler.js")

    def table(name):
        m = re.search(r"var\s+" + name + r"\s*=\s*\{(.*?)\n  \};", kp, re.S)
        if not m:
            return {}
        body = m.group(1)
        out = {}
        for pair in re.finditer(r"'?((?:[^'\\:]|\\.))'?\s*:\s*([A-Za-z_.\w]+)", body):
            key, val = pair.groups()
            if key.strip():
                out[key] = val.split(".")[-1]
        return out

    explicit = set()
    for src in (kp, enginesrc):
        for m in re.finditer(r"key\s*===\s*'((?:[^'\\]|\\.)|\\.)'", src):
            explicit.add(m.group(1))
    for m in re.finditer(r"case\s+'((?:[^'\\]|\\.)*)':", enginesrc):
        explicit.add(m.group(1))

    insert_mode = sorted(
        {m.group(1) for m in re.finditer(r"case\s+'((?:[^'\\]|\\.)*)':", handlers + ce)}
    )
    return {
        "motions": table("MOTION_KEYS"),
        "operators": table("OPERATOR_KEYS"),
        "insert": table("INSERT_KEYS"),
        "text_objects": table("TEXT_OBJ_KEYS"),
        "char_pairs": table("CHAR_PAIR_KEYS"),
        "explicit_keys": sorted(explicit),
        "insert_case_keys": insert_mode,
    }


def dump(path, text):
    path.write_text(text, encoding="utf-8")
    print(f"wrote {path.relative_to(Path.home())}  ({len(text.splitlines())} lines)")


def main():
    vk = nvi_vikeys()
    exc = nvi_excmds()
    bvi = busybox_vicmds()
    bexc = busybox_excmds()
    iv = inputvim_tables()

    dump(
        OUT / "nvi-vi-commands.txt",
        "nvi2 vi-mode key table (vi/v_cmd.c: VIKEYS vikeys[])\n"
        f"{len(vk)} entries, {sum(1 for e in vk if e['defined'])} implemented\n\n"
        + "\n".join(
            f"{'IMPL' if e['defined'] else 'NULL'}  {e['usage']:<34} | {e['desc']}  [{e['flags']}]"
            for e in vk
        ),
    )
    dump(
        OUT / "nvi-ex-commands.txt",
        "nvi2 ex command table (ex/ex_cmd.c: EXCMDLIST cmds[])\n"
        f"{len(exc)} entries\n\n"
        + "\n".join(f"{e['usage'] or e['name']:<40} | {e['desc']}" for e in exc),
    )
    dump(
        OUT / "busybox-vi-commands.txt",
        "busybox vi-mode dispatcher (editors/vi.c: do_cmd())\n"
        f"{len(bvi)} case labels; ex dispatcher: {len(bexc)} case labels "
        f"({''.join(bexc)})\n\n"
        + "\n".join(f"{e['key']!r:<6} {e['tail']}" for e in bvi),
    )
    dump(
        OUT / "input-vim-surface.txt",
        "Input Vim current surface (key-parser.js / vim-engine.js / handlers)\n\n"
        + "\n".join(
            f"{name}: {', '.join(f'{k}->{v}' for k, v in sorted(tbl.items()))}"
            for name, tbl in (
                ("MOTION_KEYS", iv["motions"]),
                ("OPERATOR_KEYS", iv["operators"]),
                ("INSERT_KEYS", iv["insert"]),
                ("TEXT_OBJ_KEYS", iv["text_objects"]),
                ("CHAR_PAIR_KEYS", iv["char_pairs"]),
            )
        )
        + f"\n\nexplicit key compares: {' '.join(iv['explicit_keys'])}"
        + f"\nhandler case labels: {' '.join(iv['insert_case_keys'])}",
    )

    print(
        f"\nnvi vi-mode: {len(vk)} entries ({sum(1 for e in vk if e['defined'])} impl)\n"
        f"nvi ex: {len(exc)}\nbusybox vi: {len(bvi)}\nbusybox ex: {len(bexc)}\n"
        f"input vim motions={len(iv['motions'])} ops={len(iv['operators'])} "
        f"insert={len(iv['insert'])} textobj={len(iv['text_objects'])}"
    )


if __name__ == "__main__":
    main()
