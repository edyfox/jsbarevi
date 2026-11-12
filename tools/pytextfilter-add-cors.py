#!/usr/bin/env python3
"""Add opt-in CORS support to a pyTextFilter server, idempotently.

Why: a browser page cannot POST to `http://127.0.0.1:31416/` directly. The
response is cross-origin and unreadable without `Access-Control-Allow-*`, and
BaseHTTPRequestHandler answers the preflight `OPTIONS` with
"501 Unsupported method ('OPTIONS')". That is why `:e` goes through
tools/dev-server.mjs by default.

With this patch the server can answer preflights itself, so a page can talk to it
directly — no proxy. It is off unless config["server"]["cors"] is true, so the
default behaviour of pyTextFilter (a local tool that only ever saw curl/SSH
clients) is unchanged.

    python3 tools/pytextfilter-add-cors.py ~/workspace/pytextfilter/pytextfilter.py

Then in that project's config.py:

    "server": {"interface": "127.0.0.1", "port": 31416, "cors": True}

and point the extension at the server directly:

    attach(el, { editorUrl: "http://127.0.0.1:31416/" })

Restart the server. `:e` now posts straight to pyTextFilter.
"""
from __future__ import annotations

import sys
from pathlib import Path

CORS_METHODS = '''
  # --- optional CORS (added by jsbarevi/tools/pytextfilter-add-cors.py) -------
  def __cors(self):
    """Send CORS headers when config["server"]["cors"] is enabled."""
    try:
      enabled = bool(config["server"].get("cors", False))
    except Exception:
      enabled = False
    if not enabled:
      return
    origin = self.headers.get("Origin", "")
    self.send_header("Access-Control-Allow-Origin", origin or "*")
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

'''

ANCHOR = "  def do_GET(self):"
MARKER = "def do_OPTIONS(self):"


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    path = Path(sys.argv[1]).expanduser()
    src = path.read_text()

    if MARKER in src:
        print(f"{path}: already patched (do_OPTIONS present), nothing to do")
        return 0
    if ANCHOR not in src:
        print(f"{path}: could not find `{ANCHOR.strip()}`, patch not applied", file=sys.stderr)
        return 1

    src = src.replace(ANCHOR, CORS_METHODS.lstrip("\n") + ANCHOR, 1)

    # add the CORS headers to both responses that a browser will read
    get_ok = '''        self.send_response(200)
        self.send_header("Content-type", "text/plain")
        self.end_headers()
        self.wfile.write(
            "Server is up and running.  "'''
    if get_ok in src:
        src = src.replace(
            get_ok,
            '''        self.send_response(200)
        self.send_header("Content-type", "text/plain")
        self.__cors()
        self.end_headers()
        self.wfile.write(
            "Server is up and running.  "''',
            1,
        )
    else:
        print("  note: GET help-text block not found; GET will be unreadable cross-origin", file=sys.stderr)

    post_ok = '''      self.send_response(200)
      self.send_header("Content-type", "text/plain")
      self.send_header("Content-length", len(content))'''
    if post_ok in src:
        src = src.replace(
            post_ok,
            '''      self.send_response(200)
      self.send_header("Content-type", "text/plain")
      self.__cors()
      self.send_header("Content-length", len(content))''',
            1,
        )
    else:
        print("  note: POST response block not found; the edited text would be unreadable cross-origin", file=sys.stderr)

    path.write_text(src)
    print(f"{path}: patched. Set config[\"server\"][\"cors\"] = True and restart.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
