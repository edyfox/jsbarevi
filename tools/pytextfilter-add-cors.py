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

Re-running upgrades an existing patch in place. Commit the file afterwards; this
never touches your config, so the feature stays off until you enable it.
"""
from __future__ import annotations

import sys
from pathlib import Path

BEGIN = "  # --- jsbarevi CORS begin ---"
END = "  # --- jsbarevi CORS end ---"

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
    self.send_header("Access-Control-Allow-Headers",
                     "content-type, x-url, x-id, authorization")
    self.send_header("Access-Control-Max-Age", "600")
    self.send_header("Vary", "Origin")

  def do_OPTIONS(self):
    """Answer the CORS preflight instead of 501 Unsupported method."""
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


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    path = Path(sys.argv[1]).expanduser()
    src = path.read_text()

    if BEGIN in src and END in src:
        start = src.index(BEGIN)
        end = src.index(END) + len(END)
        src = src[:start] + BLOCK + src[end:]
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

    path.write_text(src)
    print(f"{path}: {action}. Enable it with config[\"server\"][\"cors\"] and restart.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
