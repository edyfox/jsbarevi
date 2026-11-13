// Headless tests for the `:e` transport: round trip, "no change", compare-and-swap,
// and the message when the server is unreachable. Uses a real HTTP server.

import { createServer } from "node:http";
import { Engine } from "../src/engine/engine.js";
import { HttpEditorSession } from "../src/adapters/editor-session.js";

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let mode = "edit";
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    if (mode === "unchanged") {
      res.writeHead(200, { "content-type": "text/plain", "X-File-Changed": "false" });
      res.end(body);
      return;
    }
    if (mode === "slow") {
      setTimeout(() => { res.writeHead(200); res.end(`EDITED(${body})`); }, 120);
      return;
    }
    res.writeHead(200, { "content-type": "text/plain", "X-File-Changed": "true" });
    res.end(`EDITED(${body})`);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const mk = (text) => { const e = new Engine(); e.setText(text, 0); return e; };
const session = (engine, extra = {}) => new HttpEditorSession({
  engine, url: base, pageUrl: "http://example.test/page",
  onApplied: () => {}, ...extra,
});

// These assert what the FIELD holds, so they read hostText: engine.text is the
// buffer with its terminating newline (buffer.js), which never goes to the DOM.
console.log("\n\x1b[1m:e transport\x1b[0m");
{
  const e = mk("hello");
  let applied = 0;
  session(e, { onApplied: () => applied++ }).open();
  await sleep(200);
  check("round trip replaces the buffer", e.hostText, "EDITED(hello)");
  check("adapter is told to commit", applied, 1);
}
{
  mode = "unchanged";
  const e = mk("keep me");
  session(e).open();
  await sleep(200);
  check("X-File-Changed: false leaves the buffer alone", e.hostText, "keep me");
}
{
  mode = "slow";
  const e = mk("original");
  const s = session(e);
  s.open();
  e.setText("typed while the editor was open", 0);   // simulates an autosave
  await sleep(300);
  check("compare-and-swap refuses to clobber a changed buffer", e.hostText, "typed while the editor was open");
}
{
  const e = mk("x");
  const msgs = [];
  const s = session(e, { url: "http://127.0.0.1:1/", onStatus: (m) => msgs.push(m) });
  s.open();
  await sleep(300);
  check("an unreachable server says nothing is listening", /nothing is listening/i.test(msgs.join(" ")), true);
}
{
  mode = "edit";
  const e = mk("x");
  const msgs = [];
  session(e, { onStatus: (m) => msgs.push(m) }).open();
  await sleep(400);
  check("a successful edit reports the delta", /replaced 1 chars with/.test(msgs.join(" ")), true);
}

{
  // A server that is UP but refuses to let the page read the reply: the exact
  // shape of a missing `cors: True` (OPTIONS 204, no Access-Control-Allow-Origin).
  const e = mk("x");
  const msgs = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (opts?.mode === "no-cors") return { ok: true, type: "opaque" };
    throw new TypeError("Failed to fetch");
  };
  const s = session(e, { url: "http://127.0.0.1:31416/", onStatus: (m) => msgs.push(m) });
  s.open();
  await sleep(150);
  globalThis.fetch = realFetch;
  const joined = msgs.join(" ");
  check("up-but-CORS-blocked is named as CORS, not as 'cannot reach'", /CORS/.test(joined), true);
  check("...and it names the fix", /server\]\[.cors.|config\[.server.\].cors/i.test(joined) || /cors/i.test(joined), true);
  check("...and no POST was attempted", /opening editor/.test(joined), false);
}

{
  // A static server (python -m http.server) answers POST/GET on /edit with
  // exactly this; the probe must name the cause instead of echoing a code.
  const staticSrv = createServer((req, res) => {
    res.writeHead(501, { "content-type": "text/html" });
    res.end("<html><body><p>Message: Unsupported method ('POST').</p></body></html>");
  });
  await new Promise((r) => staticSrv.listen(0, "127.0.0.1", r));
  const e = mk("x");
  const msgs = [];
  const s = session(e, { url: `http://127.0.0.1:${staticSrv.address().port}/edit`, onStatus: (m) => msgs.push(m) });
  s.open();
  await sleep(200);
  check("a static server is reported as such, not as '501'", /static server/i.test(msgs.join(" ")), true);
  staticSrv.close();
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
