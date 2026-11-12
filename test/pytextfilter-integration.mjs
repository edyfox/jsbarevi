// Integration test against the REAL pyTextFilter server code (not a stub).
//
// It starts two copies on spare ports with `sed` as the "editor", so nothing
// opens a GUI and the developer's own session is untouched:
//   1. unpatched  -> proves why `:e` needs a proxy (OPTIONS is 501)
//   2. patched    -> proves the opt-in CORS patch lets a page talk directly
//
// Skipped when ~/workspace/pytextfilter is not present.

import { request } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PTF = path.join(os.homedir(), "workspace/pytextfilter");
const HERE = path.dirname(new URL(import.meta.url).pathname);
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

const http = (opts, body) => new Promise((resolve) => {
  const req = request({ timeout: 8000, ...opts }, (res) => {
    const out = [];
    res.on("data", (c) => out.push(c));
    res.on("end", () => resolve({
      status: res.statusCode,
      text: Buffer.concat(out).toString("utf8"),
      headers: res.headers,
    }));
  });
  req.on("error", (e) => resolve({ status: "error", text: e.message, headers: {} }));
  req.on("timeout", () => { req.destroy(); resolve({ status: "timeout", text: "", headers: {} }); });
  req.end(body);
});

/** Copy pyTextFilter into a temp dir, optionally apply the CORS patch, run it. */
async function startServer({ cors, port }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jsbarevi-ptf-"));
  const tmpdir = path.join(dir, "tmp");
  fs.mkdirSync(tmpdir);
  for (const f of ["pytextfilter.py", "filename_filter.py"]) {
    fs.copyFileSync(path.join(PTF, f), path.join(dir, f));
  }
  if (cors) {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("python3", [path.join(HERE, "..", "tools/pytextfilter-add-cors.py"), path.join(dir, "pytextfilter.py")], { encoding: "utf8" });
    if (r.status !== 0) throw new Error("CORS patch failed: " + (r.stderr || r.stdout));
  }
  fs.writeFileSync(path.join(dir, "config.py"), `
config = {
  "server": {"interface": "127.0.0.1", "port": ${port}${cors ? ', "cors": True' : ""}},
  "environment": {"tmpdir": ${JSON.stringify(tmpdir)}, "editor": ["sed", "-i", "s/hello/HELLO/", "%s"]},
}
`);
  let err = "";
  const child = spawn("python3", [path.join(dir, "pytextfilter.py")], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (d) => { err += d; });

  const ready = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) {
      const r = await http({ host: "127.0.0.1", port, path: "/", method: "GET" });
      if (r.status === 200) return true;
      await sleep(150);
    }
    return false;
  })();
  if (!ready) throw new Error(`pyTextFilter did not start on ${port}\n${err}`);
  return { child, dir, port };
}

const p1 = 34000 + Math.floor(Math.random() * 400);
const p2 = p1 + 500;

// ---------------------------------------------------------------- unpatched
console.log("\n\x1b[1munpatched pyTextFilter: why :e needs a proxy\x1b[0m");
{
  const srv = await startServer({ cors: false, port: p1 });
  const proxyPort = p1 + 1000;
  const proxy = spawn(process.execPath, [path.join(HERE, "..", "tools/dev-server.mjs"), "--port", String(proxyPort), "--editor", `127.0.0.1:${p1}`], { stdio: "ignore" });
  try {
    for (let i = 0; i < 40; i++) {
      const r = await http({ host: "127.0.0.1", port: proxyPort, path: "/edit", method: "GET" });
      if (r.status === 200) break;
      await sleep(150);
    }
    const viaProxy = await http(
      { host: "127.0.0.1", port: proxyPort, path: "/edit?url=https%3A%2F%2Fexample.test%2Fp", method: "POST",
        headers: { "content-type": "text/plain;charset=utf-8" } },
      "hello world",
    );
    check("the proxy reaches pyTextFilter and returns its edit", viaProxy.text, "HELLO world");
    check("status is 200", viaProxy.status, 200);

    // The host's own file may already carry the patch, in which case the
    // meaningful baseline is the HALF-DONE state that bit us: do_OPTIONS answers
    // 204, but with cors off there is still no Access-Control-Allow-Origin, so a
    // browser blocks the real request and JS reports "cannot reach".
    const sourcePatched = fs.readFileSync(path.join(PTF, "pytextfilter.py"), "utf8").includes("def do_OPTIONS");
    const options = await http({ host: "127.0.0.1", port: p1, path: "/", method: "OPTIONS",
      headers: { Origin: "http://127.0.0.1:8080", "Access-Control-Request-Method": "POST" } });
    if (sourcePatched) {
      check("patched source with cors off still answers OPTIONS (204)", options.status, 204);
      check("...but sends NO CORS header — the half-done state", options.headers["access-control-allow-origin"], undefined);
      console.log("       (source already patched; the 501 baseline is covered by test/editor-session.mjs)");
    } else {
      check("an unpatched server answers OPTIONS with 501 — hence the proxy", options.status, 501);
      check("...and sends no CORS header", options.headers["access-control-allow-origin"], undefined);
    }
  } finally {
    proxy.kill("SIGKILL");
    srv.child.kill("SIGKILL");
  }
}

// ------------------------------------------------------------------ patched
console.log("\n\x1b[1mCORS-patched pyTextFilter: a page can talk to it directly\x1b[0m");
{
  const srv = await startServer({ cors: true, port: p2 });
  try {
    const pre = await http({
      host: "127.0.0.1", port: p2, path: "/", method: "OPTIONS",
      headers: { Origin: "http://127.0.0.1:8080", "Access-Control-Request-Method": "POST" },
    });
    check("OPTIONS answers 204 instead of 501", pre.status, 204);
    check("the preflight echoes the page origin", pre.headers["access-control-allow-origin"], "http://127.0.0.1:8080");
    check("the preflight allows the headers we may send", /content-type/i.test(pre.headers["access-control-allow-headers"] || ""), true);

    const direct = await http(
      { host: "127.0.0.1", port: p2, path: "/", method: "POST",
        headers: { "content-type": "text/plain;charset=utf-8", Origin: "http://127.0.0.1:8080" } },
      "hello world",
    );
    check("a page can POST directly and read the result", direct.text, "HELLO world");
    check("the POST response is readable cross-origin", direct.headers["access-control-allow-origin"], "http://127.0.0.1:8080");
    check("the status is still 200", direct.status, 200);
  } finally {
    srv.child.kill("SIGKILL");
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
