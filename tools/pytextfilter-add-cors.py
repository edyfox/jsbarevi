#!/usr/bin/env python3
"""Add (or upgrade) opt-in CORS support in a pyTextFilter server, idempotently.

Why: a browser page cannot POST to `http://127.0.0.1:31416/` directly. Without
`Access-Control-Allow-*` the response is unreadable, and BaseHTTPRequestHandler
answers the preflight `OPTIONS` with "501 Unsupported method ('OPTIONS')". That is
why `:e` goes through tools/dev-server.mjs by default.

Config forms accepted for `config["server"]["cors"]`:

    False                         # default: patch is inert, nothing changes
    True                          # allow any origin (echo whatever Origin says)
    "*"                           # same as True
    ["http://127.0.0.1:8080"]     # allow-list  <- recommended
    "http://127.0.0.1:8080"       # single origin, same as a one-item list

    python3 tools/pytextfilter-add-cors.py ~/workspace/pytextfilter/pytextfilter.py

Re-running upgrades an existing patch in place, and re-running it is a no-op. The
same change is upstream in pyTextFilter itself, so a current checkout needs
nothing; this tool exists for an older copy and as the canonical definition of
what the patch is. Commit the file afterwards; this never touches your config, so
the feature stays off until you enable it.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

BEGIN = "  # --- jsbarevi CORS begin ---"
END = "  # --- jsbarevi CORS end ---"

# The markers are matched as WHOLE LINES, not as substrings. Searching for BEGIN as a
# plain substring finds it two characters into its own line whenever the line carries an
# extra indent (which a hand-edit, or a previous run of this very tool, can leave), and
# the replacement then keeps the stray indent and adds a new one: re-running "upgrades"
# the block by two spaces per run. A line-anchored regex is idempotent by construction.
BLOCK_RE = re.compile(
    r"^[ ]*# --- jsbarevi CORS begin ---$\n.*?^[ ]*# --- jsbarevi CORS end ---$",
    re.MULTILINE | re.DOTALL,
)

BLOCK = BEGIN + '''
  def __allowed_origins(self):
    """Return the configured allow-list, True for any origin, or None."""
    try:
      setting = config["server"].get("cors", False)
    except Exception:
      return None
    if setting is True or setting == "*":
      return True
    if isinstance(setting, str):
      return [setting]
    if isinstance(setting, (list, tuple, set)):
      return [o for o in setting if isinstance(o, str)]
    return None

  def __cors(self):
    """Send CORS headers when config["server"]["cors"] permits this origin."""
    allowed = self.__allowed_origins()
    if not allowed:
      return
    origin = self.headers.get("Origin", "")
    if allowed is True:
      self.send_header("Access-Control-Allow-Origin", origin or "*")
    elif origin in allowed:
      self.send_header("Access-Control-Allow-Origin", origin)
    else:
      self.send_header("Vary", "Origin")
      return
    self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    # Every request header the transport can send, or the preflight rejects it: the
    # token is real (X-Edit-Token) and only appears when a session configures one.
    self.send_header("Access-Control-Allow-Headers",
                     "content-type, x-url, x-id, authorization, x-edit-token")
    self.send_header("Access-Control-Max-Age", "600")
    self.send_header("Vary", "Origin")

  def do_OPTIONS(self):
    """Answer the CORS preflight — when CORS is enabled, that is.

    With `cors` unset this answers exactly what the stock server answers (501), so
    installing the patch on a server nobody configured is a true no-op rather than a
    subtle behaviour change.
    """
    if not self.__allowed_origins():
      self.send_error(501, "Unsupported method (%r)" % self.command)
      return
    self.send_response(204)
    self.__cors()
    self.send_header("Content-length", "0")
    self.end_headers()
''' + END

ANCHOR = "  def do_GET(self):"
GET_ANCHOR = '''        self.send_response(200)
        self.send_header("Content-type", "text/plain")
        self.end_headers()'''
GET_WITH_CORS = '''        self.send_response(200)
        self.send_header("Content-type", "text/plain")
        self.__cors()
        self.end_headers()'''
POST_ANCHOR = '''      self.send_response(200)
      self.send_header("Content-type", "text/plain")
      self.send_header("Content-length", len(content))'''
POST_WITH_CORS = '''      self.send_response(200)
      self.send_header("Content-type", "text/plain")
      self.__cors()
      self.send_header("Content-length", len(content))'''
# A 500 from a cross-origin request is otherwise indistinguishable from a dead server:
# the browser blocks the body that says "Invalid request". The error path is exactly
# where a diagnostic is worth most, so it carries the headers too.
ERROR_ANCHOR = '''      self.send_response(500)
      self.send_header("Content-length", len(content))
      self.send_header("Content-type", "text/plain")'''
ERROR_WITH_CORS = '''      self.send_response(500)
      self.send_header("Content-length", len(content))
      self.send_header("Content-type", "text/plain")
      self.__cors()'''


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    path = Path(sys.argv[1]).expanduser()
    src = path.read_text()

    if BLOCK_RE.search(src):
        src = BLOCK_RE.sub(lambda _m: BLOCK, src, count=1)
        action = "upgraded"
    elif "def do_OPTIONS" in src:
        # legacy first-generation patch (no markers): replace from its header
        # comment through the end of do_OPTIONS
        legacy = src.find("# --- optional CORS (added by jsbarevi/tools/pytextfilter-add-cors.py)")
        opt = src.find("  def do_OPTIONS(self):", legacy if legacy >= 0 else 0)
        if legacy < 0 or opt < 0:
            print(f"{path}: has do_OPTIONS but this tool cannot locate its block — refusing to guess", file=sys.stderr)
            return 1
        tail = src.find("    self.end_headers()", opt)
        if tail < 0:
            print(f"{path}: do_OPTIONS body not recognised", file=sys.stderr)
            return 1
        src = src[:legacy] + BLOCK + src[tail + len("    self.end_headers()"):]
        action = "upgraded (legacy patch replaced)"
    else:
        if ANCHOR not in src:
            print(f"{path}: `def do_GET` not found, nothing patched", file=sys.stderr)
            return 1
        src = src.replace(ANCHOR, BLOCK + "\n" + ANCHOR, 1)
        action = "patched"

    # CORS headers on the two responses a browser reads (idempotent)
    if GET_ANCHOR in src and GET_WITH_CORS not in src:
        src = src.replace(GET_ANCHOR, GET_WITH_CORS, 1)
    elif "self.__cors()\n        self.end_headers()" not in src:
        print("  note: GET help-text block not found; GET stays unreadable cross-origin", file=sys.stderr)

    if POST_ANCHOR in src and POST_WITH_CORS not in src:
        src = src.replace(POST_ANCHOR, POST_WITH_CORS, 1)
    elif "self.__cors()\n      self.send_header(\"Content-length\", len(content))" not in src:
        print("  note: POST response block not found; edited text stays unreadable cross-origin", file=sys.stderr)

    if ERROR_ANCHOR in src and ERROR_WITH_CORS not in src:
        src = src.replace(ERROR_ANCHOR, ERROR_WITH_CORS, 1)
    elif "self.send_header(\"Content-type\", \"text/plain\")\n      self.__cors()" not in src:
        print("  note: 500 error block not found; a failure stays unreadable cross-origin", file=sys.stderr)

    path.write_text(src)
    print(f"{path}: {action}. Enable it with config[\"server\"][\"cors\"] and restart.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
