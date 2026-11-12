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

console.log("\n\x1b[1m:e transport\x1b[0m");
{
  const e = mk("hello");
  let applied = 0;
  session(e, { onApplied: () => applied++ }).open();
  await sleep(200);
  check("round trip replaces the buffer", e.text, "EDITED(hello)");
  check("adapter is told to commit", applied, 1);
}
{
  mode = "unchanged";
  const e = mk("keep me");
  session(e).open();
  await sleep(200);
  check("X-File-Changed: false leaves the buffer alone", e.text, "keep me");
}
{
  mode = "slow";
  const e = mk("original");
  const s = session(e);
  s.open();
  e.setText("typed while the editor was open", 0);   // simulates an autosave
  await sleep(300);
  check("compare-and-swap refuses to clobber a changed buffer", e.text, "typed while the editor was open");
}
{
  const e = mk("x");
  const msgs = [];
  const s = session(e, { url: "http://127.0.0.1:1/", onStatus: (m) => msgs.push(m) });
  s.open();
  await sleep(300);
  check("unreachable server explains itself", /cannot reach|error/i.test(msgs.join(" ")), true);
}
{
  const e = mk("x");
  const msgs = [];
  session(e, { onStatus: (m) => msgs.push(m) }).open();
  await sleep(200);
  check("a successful edit reports the delta", /replaced 1 chars with/.test(msgs.join(" ")), true);
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
