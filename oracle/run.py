#!/usr/bin/env python3
"""Differential oracle harness.

Runs one keystroke sequence against several reference editors and compares the
resulting buffer and cursor. The point is not to test *our* engine here — it is
to pin down the reference behaviour first, so that the engine can be written
against measurements instead of assumptions.

Oracle of record:
  * **scope**  (does this command exist, what does it take) -> busybox vi
  * **behaviour** (what exactly does it do)                 -> vim, pinned options

Engines:
  vim      -N -u NONE -n -i NONE -es  +  :normal!  (buffer + line + column)
  busybox  pty-driven `busybox vi`                 (buffer only)
  nvi      pty-driven `nvi`                        (buffer only)

Case schema (JSON):

    {
      "name":  "j moves one buffer line, not one rendered line",
      "input": "one\\ntwo\\nthree\\n",
      "keys":  "jj",
      "expect": { "line": 3, "col": 1 }
    }

`expect` may contain `text`, `line`, `col`. Per-engine overrides are allowed via
`expect_by_engine`, and `engines` restricts which engines run the case.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import pty
import re
import select
import signal
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import time
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Canonical, engine-neutral key notation used in case files.
TOKEN_TO_VIM = {
    "<Esc>": "\\<Esc>",
    "<CR>": "\\<CR>",
    "<Tab>": "\\<Tab>",
    "<BS>": "\\<BS>",
    # redo: vim only (nvi's `u` toggles, busybox has no redo), but the token has
    # to exist or a redo case aborts the whole run
    "<C-r>": "\\<C-R>",
}
TOKEN_TO_BYTES = {
    "<Esc>": b"\x1b",
    "<CR>": b"\r",
    "<Tab>": b"\t",
    "<BS>": b"\x7f",
    "<C-r>": b"\x12",
}


TOKEN_RE = re.compile(r"<[A-Za-z-]+>")


def _translate(keys: str, table: dict) -> str:
    out, pos = [], 0
    for m in TOKEN_RE.finditer(keys):
        out.append(keys[pos:m.start()])
        out.append(table[m.group(0)])
        pos = m.end()
    out.append(keys[pos:])
    return "".join(out)


def to_vim_keys(keys: str) -> str:
    r"""<Esc> -> \<Esc>, which is what `execute "normal! ..."` understands."""
    # a literal double quote would otherwise end the execute string
    return _translate(keys.replace('"', '\\"'), TOKEN_TO_VIM)


def to_bytes(keys: str) -> bytes:
    """Same notation, as the bytes a terminal would deliver."""
    out, pos = bytearray(), 0
    for m in TOKEN_RE.finditer(keys):
        out += keys[pos:m.start()].encode()
        out += TOKEN_TO_BYTES[m.group(0)]
        pos = m.end()
    out += keys[pos:].encode()
    return bytes(out)


@dataclass
class Result:
    engine: str
    status: str  # PASS | FAIL | ERROR | SKIP
    text: str | None = None
    line: int | None = None
    col: int | None = None
    detail: str = ""


# --------------------------------------------------------------------------- vim
def run_vim(text: str, keys: str, workdir: Path, options: dict | None = None) -> Result:
    f = workdir / "buffer.txt"
    pos = workdir / "pos.txt"
    script = workdir / "script.ex"
    f.write_text(text)
    # A case may pin the reference's own options ("options" in the case, same shape
    # test/lib/engine-driver.mjs takes). Without this the run silently uses vim's
    # defaults and a case that documents a configured reference is really testing
    # something else - e.g. joinspaces, which is ON in this invocation.
    settings = [
        f"set {k}" if v is True else f"set no{k}" if v is False else f"set {k}={v}"
        for k, v in (options or {}).items()
    ]
    # ex mode positions the cursor on the LAST line (ed heritage), so a case that
    # does not say otherwise must be pinned to 1:1 first.
    script.write_text(
        "\n".join(
            [
                "set nomodeline",
                *settings,
                f"call cursor({1}, {1})",
                # feedkeys, not :normal! - a beeping key aborts :normal! and the
                # rest of the sequence never runs (measured 2026-11-12)
                f'call feedkeys("{to_vim_keys(keys)}", "ntx")',
                f"call writefile([printf('%d:%d', line('.'), col('.'))], '{pos}')",
                "wq!",
            ]
        )
        + "\n"
    )
    cmd = [
        "vim", "-N", "-u", "NONE", "-n", "-i", "NONE", "-es",
        "-S", str(script), str(f),
    ]
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=20, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return Result("vim", "ERROR", detail="timeout")
    if not pos.exists():
        return Result("vim", "ERROR", detail=(p.stderr or b"").decode()[:200] or "no position file")
    line, col = (int(x) for x in pos.read_text().strip().split(":"))
    got = f.read_text()
    if p.returncode != 0 and not got:
        return Result("vim", "ERROR", detail=f"rc={p.returncode}")
    return Result("vim", "PASS", text=got, line=line, col=col)


# ------------------------------------------------------------------- pty engines
def _pump(fd: int, until: float) -> bytes:
    """Read whatever is available until `until`, never blocking past it."""
    out = b""
    while True:
        left = until - time.time()
        if left <= 0:
            return out
        r, _, _ = select.select([fd], [], [], min(left, 0.05))
        if fd not in r:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            return out
        if not chunk:
            return out
        out += chunk


def run_pty(engine: str, text: str, keys: str, workdir: Path, timeout: float = 12.0) -> Result:
    """Drive a real terminal editor. Buffer text only: position is not observable.

    busybox vi and nvi have no scriptable mode, so this is a pty: start, send the
    keys at a human-ish pace, ask the editor to write and quit, then read the file.
    Every wait has a deadline and the child is always reaped, so a hung or
    unresponsive engine fails the case instead of hanging the suite.
    """
    f = workdir / "buffer.txt"
    f.write_text(text)
    argv = {"busybox": ["busybox", "vi"], "nvi": ["nvi"]}[engine] + [str(f)]

    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update({"TERM": "xterm", "LANG": "C.UTF-8"})
        try:
            os.execvp(argv[0], argv)
        finally:
            os._exit(127)

    started = time.time()
    exited = False
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        _pump(fd, time.time() + 0.8)          # first paint / banner
        for byte in to_bytes(keys):
            os.write(fd, bytes([byte]))
            time.sleep(0.02)
        _pump(fd, time.time() + 0.25)
        os.write(fd, b":wq\r")                # write and quit
        _pump(fd, time.time() + 1.5)
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            exited = True
        # reap with a deadline; never block forever
        for _ in range(40):
            done, _status = os.waitpid(pid, os.WNOHANG)
            if done:
                exited = True
                break
            time.sleep(0.05)
        if not exited:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)
    except OSError as exc:
        return Result(engine, "ERROR", detail=str(exc))
    finally:
        try:
            os.close(fd)
        except OSError:
            pass

    took = time.time() - started
    if not f.exists():
        return Result(engine, "ERROR", detail="buffer file vanished")
    if took >= timeout:
        return Result(engine, "ERROR", detail=f"timed out after {took:.1f}s")
    return Result(engine, "PASS", text=f.read_text())


# ------------------------------------------------------------------------- runner
ENGINES = ("vim", "busybox", "nvi")


def check(expect: dict, res: Result) -> tuple[bool, str]:
    """Text-only engines cannot report a position. A position-only expectation
    is therefore SKIP, not FAIL; a mixed one asserts the text and says so."""
    if "text" not in expect and res.line is None:
        return True, "position not observable on this engine (SKIP)"
    bad = []
    if "text" in expect and res.text is not None and res.text != expect["text"]:
        bad.append(f"text {res.text!r} != {expect['text']!r}")
    if "line" in expect:
        if res.line is None:
            pass  # text-only engine: already reported as unobservable
        elif res.line != expect["line"]:
            bad.append(f"line {res.line} != {expect['line']}")
    if "col" in expect:
        if res.col is None:
            pass
        elif res.col != expect["col"]:
            bad.append(f"col {res.col} != {expect['col']}")
    return (not bad), "; ".join(bad)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cases", nargs="*", help="case files (default: all in oracle/cases)")
    ap.add_argument("--engine", action="append", choices=ENGINES, help="restrict engines")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    files = [Path(c) for c in args.cases] or sorted((HERE / "cases").glob("*.json"))
    if not files:
        print("no case files", file=sys.stderr)
        return 2

    engines = tuple(args.engine) if args.engine else ENGINES
    available = {e: shutil.which("busybox" if e == "busybox" else e) is not None for e in ENGINES}

    failures = 0
    total = 0
    for path in files:
        spec = json.loads(path.read_text())
        print(f"\n\033[1m{path.name}\033[0m")
        for case in spec["cases"]:
            total += 1
            print(f"  \033[1m{case['name']}\033[0m")
            print(f"    keys={case['keys']!r}")
            for engine in case.get("engines", engines):
                if engine not in engines:
                    continue
                if not available.get(engine):
                    print(f"      {engine:<8} SKIP (binary not found)")
                    continue
                per_engine = case.get("expect_by_engine", {})
                expect = per_engine.get(engine) or case.get("expect")
                if expect is None:
                    print(f"      {engine:<8} SKIP (no expectation for this engine)")
                    continue
                with tempfile.TemporaryDirectory(dir=os.environ.get("XDG_RUNTIME_DIR") or "/tmp") as td:
                    td = Path(td)
                    try:
                        res = (run_vim if engine == "vim" else
                               (lambda t, k, w, o: run_pty(engine, t, k, w)))(case["input"], case["keys"], td, case.get("options"))
                    except Exception as exc:  # noqa: BLE001
                        res = Result(engine, "ERROR", detail=f"{type(exc).__name__}: {exc}")
                ok, why = check(expect, res)
                if res.status == "PASS" and ok and why.startswith("position not observable"):
                    res.status = "SKIP"
                if res.status == "PASS" and not ok:
                    res.status = "FAIL"
                    res.detail = why
                if res.status in ("FAIL", "ERROR"):
                    failures += 1
                mark = {"PASS": "\033[32mPASS\033[0m", "FAIL": "\033[31mFAIL\033[0m",
                        "ERROR": "\033[33mERR \033[0m", "SKIP": "SKIP"}[res.status]
                where = ""
                if res.line is not None:
                    where = f" @{res.line}:{res.col}"
                print(f"      {engine:<8} {mark}{where}  {res.detail}")
                if args.verbose and res.text is not None:
                    print(f"        text={res.text!r}")
    print(f"\n{total} cases, {failures} non-pass")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
