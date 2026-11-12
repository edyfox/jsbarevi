#!/usr/bin/env python3
"""Enable the opt-in CORS flag in a pyTextFilter config, safely.

Adds `"cors": True` to the `server` dict of config.py, so the
`do_OPTIONS`/`__cors` support added by tools/pytextfilter-add-cors.py actually
sends headers. Without it the patch is inert: OPTIONS answers 204 but with no
`Access-Control-Allow-Origin`, and a browser then refuses to send the real
request - reported as "cannot reach".

Prints the exact change and stops if it is already enabled.

    python3 tools/enable-pytextfilter-cors.py ~/workspace/pytextfilter/config.py
    python3 tools/enable-pytextfilter-cors.py ~/workspace/pytextfilter/config.py \
        --origin http://127.0.0.1:8080      # allow-list instead of any origin

Then RESTART the server: config is imported once, so a running process keeps the
old value.

SECURITY: while this is on, any page you visit can POST to the editor server and
read the reply (the origin is echoed rather than `*`, but that still admits every
origin). Leave it off for day-to-day pyTextFilter use and use the /edit proxy, or
flip it on only while testing.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

WARN = """\
  NOTE: with cors enabled, any page in any browser can drive this server while it
  runs. Prefer the /edit proxy (tools/dev-server.mjs) for daily use.
"""


def main() -> int:
    argv = [a for a in sys.argv[1:]]
    origins = []
    while "--origin" in argv:
        i = argv.index("--origin")
        origins.append(argv[i + 1])
        del argv[i : i + 2]
    if len(argv) != 1:
        print(__doc__)
        return 2
    path = Path(argv[0]).expanduser()
    if not path.exists():
        print(f"{path}: not found", file=sys.stderr)
        return 1
    src = path.read_text()

    value = "[" + ", ".join('"%s"' % o for o in origins) + "]" if origins else "True"
    if re.search(r'["\']cors["\']\s*:\s*(True|\[|")', src):
        print(f"{path}: cors is already enabled; remove the key first to change it")
        return 0

    # find the server dict and its span
    m = re.search(r'(["\']server["\']\s*:\s*\{)', src)
    if not m:
        print(f"{path}: no `\"server\": {{...}}` block found", file=sys.stderr)
        return 1
    start = m.end()
    depth = 1
    i = start
    while i < len(src) and depth:
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
        i += 1
    if depth:
        print(f"{path}: unbalanced braces in the server block", file=sys.stderr)
        return 1
    block = src[start : i - 1]

    # insert before the closing brace, matching the block's own formatting
    ins = ',\n    "cors": %s\n  ' % value if "\n" in block else ', "cors": %s ' % value
    new_block = block.rstrip().rstrip(",") + ins
    patched = src[:start] + new_block + src[i - 1 :]

    print("--- change ---")
    print(f"  server: {{{block.strip()}}}")
    print(f"  +\n  server: {{{new_block.strip()}}}")
    print("--------------")
    path.write_text(patched)
    print(f"{path}: cors enabled. RESTART the server (config is read once at startup).")
    print(WARN)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
