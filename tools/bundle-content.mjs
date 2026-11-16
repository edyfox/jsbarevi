// Bundle the packaged content script for a PAGE-WORLD payload.
//
// Two hosts need this and neither can use a content script: Lark (custom scheme, no
// extension system in liblark.so) and Cursor (an Electron workbench whose CSP forbids
// dynamic script injection but allows a sibling file). Both get one classic script that
// contains the engine, and both must contain the SAME bytes the extension ships — a
// second copy of these esbuild options is exactly how a payload drifts from the build the
// tests cover, and the Lark seam already paid for that once ("INSTALLED (STALE)").
//
// The packager is invoked, never re-implemented: `build-extension.mjs` owns the bundle,
// including the one-engine-per-document guard it wraps around it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** `{ content, blocker }` — the two classic scripts, freshly built. */
export function bundleContentScripts() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jsbarevi-payload-"));
  try {
    execFileSync(process.execPath, [
      path.join(ROOT, "tools", "build-extension.mjs"), "--no-zip", "--out", tmp,
    ], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
    const read = (name) => {
      const file = path.join(tmp, name);
      if (!fs.existsSync(file)) throw new Error(`build-extension produced no ${name}`);
      const source = fs.readFileSync(file, "utf8");
      if (/^\s*(import|export)\s/m.test(source)) throw new Error(`${name} is not a classic script`);
      return source;
    };
    // The stamp of the build that was JUST made, not of whatever is in dist/: this
    // bundle goes to a temp dir, so `dist/build.json` can be older than the code inlined.
    let build = {};
    try { build = JSON.parse(fs.readFileSync(path.join(tmp, "build.json"), "utf8")); } catch { /* older packager */ }
    return { content: read("content.js"), blocker: read("escape-blocker.js"), build };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export { ROOT };
