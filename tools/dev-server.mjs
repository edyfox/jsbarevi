#!/usr/bin/env node
// Dev server: serves the repo AND proxies `/edit` to a real edit-server.
//
// Why a proxy at all: a page cannot read a cross-origin response without CORS,
// and TextEditAid-style servers additionally reject any Origin that is not
// `chrome-extension:`. A proxy is same-origin for the page and can present the
// header the server expects, so the real edit-server needs no changes.
//
//   node tools/dev-server.mjs                        # proxy to 127.0.0.1:31416
//   node tools/dev-server.mjs --editor 127.0.0.1:8888
//   node tools/dev-server.mjs --auth user:pass       # if the server wants Basic
//
// Then open http://127.0.0.1:8080/test/e2e.html and press `:e`.

import { createServer, request } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number(arg("port", "8080"));
const EDITOR = arg("editor", "127.0.0.1:31416");
const AUTH = arg("auth", null);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const server = createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);

  if (url === "/edit") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const headers = {
        "content-type": "text/plain; charset=utf-8",
        "content-length": body.length,
        // What a real extension would send; what TextEditAid-style servers check.
        Origin: "chrome-extension://jsbarevi-dev",
      };
      // emacs_chrome-style edit-servers read these headers for naming/reporting
      if (req.headers["x-url"]) headers["x-url"] = req.headers["x-url"];
      if (req.headers["x-id"]) headers["x-id"] = req.headers["x-id"];
      if (AUTH) headers.Authorization = "Basic " + Buffer.from(AUTH).toString("base64");
      const proxied = request(
        { host: EDITOR.split(":")[0], port: Number(EDITOR.split(":")[1] || 80), path: req.url, method: "POST", headers },
        (upstream) => {
          const out = [];
          upstream.on("data", (c) => out.push(c));
          upstream.on("end", () => {
            res.writeHead(upstream.statusCode || 502, { "content-type": "text/plain; charset=utf-8" });
            res.end(Buffer.concat(out));
          });
        },
      );
      proxied.on("error", (err) => {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(`edit-server at ${EDITOR} is unreachable: ${err.message}\n`);
      });
      proxied.end(body);
    });
    return;
  }

  const file = path.join(ROOT, url === "/" ? "test/e2e.html" : url);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(file)] || "application/octet-stream",
    "cache-control": "no-store",   // never test a stale fixture
  });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`jsbarevi dev server  http://127.0.0.1:${PORT}/test/e2e.html`);
  console.log(`  :e  ->  proxy  ->  edit-server ${EDITOR}${AUTH ? "  (Basic auth)" : ""}`);
});
