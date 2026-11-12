// `:e` — hand the buffer to a real editor and take it back.
//
// Wire-compatible with pyTextFilter (and its TextEditAid ancestor): POST the
// buffer as the raw request body, keep the request open while the editor runs,
// and read the new text from the response body. The page URL rides in the query
// string so the server can name its temp file after the page; servers that
// prefer headers get x-url/x-id from the proxy.
//
// Two things this deliberately does NOT pretend:
//   * a page-world caller cannot hold a secret, so a token here is a CSRF
//     barrier only; the real boundary is the transport (extension origin,
//     native messaging, or a main-process channel)
//   * a cross-origin response is unreadable without CORS, so a browser page
//     talking to localhost gets a clear message instead of a silent no-op

export class HttpEditorSession {
  constructor(opts) {
    this.engine = opts.engine;
    this.url = opts.url;
    this.pageUrl = opts.pageUrl ?? (typeof location !== "undefined" ? location.href : "");
    this.token = opts.token ?? null;
    this.basic = opts.basic ?? null;
    this.headers = opts.headers || {};   // extension/native contexts only
    this.timeout = opts.timeout ?? 15 * 60 * 1000;
    this.onStatus = opts.onStatus || (() => {});
    this.onApplied = opts.onApplied || (() => {});
    this.busy = false;
    this.ready = null;      // resolved probe result
    this._probeStarted = false;
  }

  /** Ask the endpoint whether it is really the proxy, without launching anything. */
  probe() {
    if (this._probeStarted) return this.ready;
    this._probeStarted = true;
    const url = new URL(this.url, this.pageUrl);
    this.ready = fetch(url.toString(), { method: "GET", cache: "no-store" })
      .then(async (res) => {
        const body = await res.text().catch(() => "");
        if (res.ok && !/Unsupported method/.test(body)) return { ok: true };
        if (res.status === 501 && /POST/.test(body)) {
          return { ok: false, why: "this page is served by a static server (it has no POST handler) — run `npm run dev`, not `python3 -m http.server`" };
        }
        if (res.status === 404) {
          return { ok: false, why: `${url.pathname} is not served here — run \`npm run dev\` so /edit reaches pyTextFilter` };
        }
        return { ok: false, why: `${res.status} from ${url.pathname}` };
      })
      .catch((err) => ({ ok: false, why: this._explain(err) }));
    return this.ready;
  }

  describe() {
    return `[editor] ${this.url}`;
  }

  /** Returns immediately: `:e` is asynchronous by nature (a human is editing). */
  open() {
    if (this.busy) return { ok: false, message: "editor session already open" };
    // Refuse with a diagnosis rather than a status code: a 501 from a static
    // server is indistinguishable from a broken editor in the status line.
    this.probe().then((r) => {
      if (!r.ok) this.onStatus(`:e unavailable — ${r.why}`, "error");
    });
    this.busy = true;
    const sent = this.engine.text;
    const cursorBefore = this.engine.cursor;

    const url = new URL(this.url, this.pageUrl);
    if (this.pageUrl) url.searchParams.set("url", this.pageUrl);

    // A cross-origin endpoint means the browser sends a CORS preflight, and
    // Python's http.server answers OPTIONS with "501 Unsupported method".
    if (typeof location !== "undefined" && url.origin !== location.origin) {
      this.onStatus(
        `:e -> ${url.host}${url.pathname} is cross-origin: the browser will preflight it and the server answers 501. ` +
          `Serve the page through tools/dev-server.mjs and use /edit.`,
        "error",
      );
    }
    // Keep the page-side request "simple": a custom header triggers a CORS
    // preflight, and pyTextFilter (like emacs_chrome's server) answers OPTIONS
    // with 501. The proxy (or an extension with host permissions) adds
    // x-url/x-id instead.
    this.onStatus(`opening editor… ${url.host}${url.pathname} (finish there to return)`);
    const headers = { "Content-Type": "text/plain;charset=utf-8", ...this.headers };
    if (this.token) headers["X-Edit-Token"] = this.token;
    if (this.basic) headers.Authorization = `Basic ${btoa(this.basic)}`;

    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeout) : null;

    fetch(url.toString(), {
      method: "POST",
      body: sent,
      headers,
      signal: controller?.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          // include the body: Python's http.server answers OPTIONS with a page
          // that names the unsupported method, which is the whole diagnosis
          const body = (await res.text().catch(() => "")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
          const hint = res.status === 501 && /POST/i.test(body)
            ? " — this is a static server with no POST handler: run `npm run dev` so /edit reaches pyTextFilter"
            : res.status === 501
              ? " — 501 here means a CORS preflight (OPTIONS), i.e. the request bypassed the /edit proxy"
              : "";
          throw new Error(`${res.status} ${res.statusText || ""}${hint}${body ? ": " + body : ""}`);
        }
        const text = await res.text();
        if (res.headers.get("X-File-Changed") === "false") {
          this.onStatus("editor closed without changes");
          return;
        }
        if (this.engine.text !== sent) {
          this.onStatus("field changed while editing — result discarded, :e again", "error");
          return;
        }
        this.engine.setText(text, Math.min(cursorBefore, Math.max(0, text.length - 1)));
        this.onStatus(`replaced ${sent.length} chars with ${text.length}`);
        this.onApplied();
      })
      .catch((err) => {
        this.onStatus(this._explain(err), "error");
      })
      .finally(() => {
        this.busy = false;
        if (timer) clearTimeout(timer);
      });

    return { ok: true, message: "" };
  }

  write() { return { ok: true, message: "the editor writes when it exits" }; }
  close() { /* the request owns the session's lifetime */ }

  _explain(err) {
    const msg = String(err?.message || err);
    if (/abort/i.test(msg)) return "editor session timed out";
    if (/failed to fetch|networkerror|load failed/i.test(msg)) {
      return `cannot reach ${this.url} — is the edit-server running, and does it allow this origin? (a page cannot read a cross-origin response without CORS; the real extension uses its own origin)`;
    }
    return `editor error: ${msg}`;
  }
}
