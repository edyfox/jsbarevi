// The dev server must serve a build stamp that describes the code it is serving
// RIGHT NOW. It used to serve the file on disk, which is stamped before a commit and
// therefore describes the previous commit forever - a stale label on current code,
// which is the one confusion the label exists to prevent.
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDirty } from "../tools/build-id.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

console.log("\n\x1b[1mbuild identity\x1b[0m");
eq("the generated stamp file does not make the tree dirty",
  isDirty(" M src/build-info.js\n"), false);
eq("a real modification does",
  isDirty(" M src/build-info.js\n M src/engine/engine.js\n"), true);
eq("untracked files are not passed in, so an empty listing is clean", isDirty(""), false);

const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const port = 8200 + Math.floor(Math.random() * 200);
const server = spawn("node", [path.join(ROOT, "tools/dev-server.mjs"), "--port", String(port)], { cwd: ROOT, stdio: "ignore" });
try {
  let up = false;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/test/e2e.html`); if (r.ok) { up = true; break; } } catch { /* not yet */ }
    await sleep(50);
  }
  eq("the dev server answers", up, true);
  const res = await fetch(`http://127.0.0.1:${port}/src/build-info.js`);
  const body = await res.text();
  const served = (body.match(/BUILD = "([^"]+)"/) || [])[1];
  eq("the served stamp names the commit being served, not a stale file", served?.startsWith(head), true);
  eq("...and says +dirty only when the tree really is", served?.endsWith("+dirty"),
    execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: ROOT, encoding: "utf8" })
      .split("\n").map((l) => l.slice(3).trim()).filter((f) => f && f !== "src/build-info.js").length > 0);
  eq("...and is never cached", res.headers.get("cache-control"), "no-store");
  // The label printed in the field (`:version`, the status line) is `${VERSION}+${stamp}`.
  // The VERSION half must come from package.json: while it was a literal in src/entry.js,
  // a 0.6.0 build announced itself as 0.1.0 and read as a stale copy.
  const servedVersion = (body.match(/VERSION = "([^"]+)"/) || [])[1];
  const pkgVersion = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  eq("the served semver is package.json's, not a source literal", servedVersion, pkgVersion);
  const engine = await fetch(`http://127.0.0.1:${port}/src/engine/engine.js`);
  eq("the engine is served too", (await engine.text()).includes("case \"gj\": case \"gk\""), true);
} finally {
  server.kill("SIGKILL");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
