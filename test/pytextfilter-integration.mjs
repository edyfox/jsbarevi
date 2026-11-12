// Integration test against the REAL pyTextFilter server code (not a stub).
//
// It starts a second pyTextFilter instance on a spare port with `sed` as the
// "editor", so nothing opens a GUI and the developer's own session is untouched,
// then drives it through the dev-server proxy exactly as `:e` does.
//
// Skipped when ~/workspace/pytextfilter is not present.

import { createServer, request } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PTF = path.join(os.homedir(), "workspace/pytextfilter");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(path.join(PTF, "pytextfilter.py"))) {
  console.log("SKIP: pyTextFilter not found at " + PTF);
  process.exit(0);
}

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jsbarevi-ptf-"));
const tmpdir = path.join(dir, "tmp");
fs.mkdirSync(tmpdir);
const port = 33000 + Math.floor(Math.random() * 900);

// A minimal config in the *shape* pyTextFilter expects; editor is sed so the
// round trip is deterministic and headless.
fs.writeFileSync(path.join(dir, "config.py"), `
config = {
  "server": {"interface": "127.0.0.1", "port": ${port}},
  "environment": {"tmpdir": ${JSON.stringify(tmpdir)}, "editor": ["sed", "-i", "s/hello/HELLO/", "%s"]},
}
`);
for (const f of ["pytextfilter.py", "filename_filter.py"]) {
  fs.copyFileSync(path.join(PTF, f), path.join(dir, f));
}

const server = spawn("python3", [path.join(dir, "pytextfilter.py")], { cwd: dir, stdio: "ignore" });
await sleep(700);

// the dev-server proxy, pointed at the spare pyTextFilter instance
const proxy = spawn(process.execPath, [
  path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..", "tools/dev-server.mjs"),
  "--port", String(port + 1000), "--editor", `127.0.0.1:${port}`,
], { stdio: "ignore" });
await sleep(600);

const post = (body, headers = {}) => new Promise((resolve, reject) => {
  const req = request(
    { host: "127.0.0.1", port: port + 1000, path: "/edit?url=https%3A%2F%2Fexample.test%2Fpage", method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8", "content-length": Buffer.byteLength(body), ...headers } },
    (res) => {
      const out = [];
      res.on("data", (c) => out.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(out).toString("utf8") }));
    },
  );
  req.on("error", reject);
  req.end(body);
});

console.log("\n\x1b[1mpyTextFilter (real code) through the :e proxy\x1b[0m");
try {
  const r = await post("hello world");
  check("the proxy reaches pyTextFilter and returns its edit", r.text, "HELLO world");
  check("status is 200", r.status, 200);

  const unchanged = await post("nothing to substitute");
  check("text the editor leaves alone comes back verbatim", unchanged.text, "nothing to substitute");

  // direct (no proxy) must fail exactly the way a page fetch would: no CORS
  // headers, and OPTIONS unsupported
  const direct = await new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: "/", method: "OPTIONS" }, (res) => resolve(res.statusCode));
    req.on("error", () => resolve("error"));
    req.end();
  });
  check("pyTextFilter answers OPTIONS with 501 — hence the proxy", direct, 501);
} finally {
  server.kill("SIGKILL");
  proxy.kill("SIGKILL");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
