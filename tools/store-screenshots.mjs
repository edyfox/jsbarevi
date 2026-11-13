#!/usr/bin/env node
// Store screenshots: load the PACKAGED extension in Chrome for Testing, drive it with
// real keys on the demo page, and save 1280x800 PNGs for the Chrome Web Store.
//
// Why generated rather than hand-taken: the store wants a fixed 1280x800, the image
// has to show the real engine (a mock-up would be a lie), and a regenerable image
// stays honest after the UI changes. The caption lives in the demo page's footer, so
// a screenshot and its caption cannot disagree.
//
//   npm run store:shots        # writes store/screenshots/*.png

import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome, evaluate, waitFor, openPage, typeKeys, sleep } from "../test/lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const OUT = path.join(ROOT, "store", "screenshots");
const W = 1280;
const H = 800;

function serve() {
  const server = createServer((req, res) => {
    const file = path.join(ROOT, "store", "demo.html");
    if (!fs.existsSync(file)) { res.writeHead(404).end("no demo"); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function shot(page, name, caption, stamp) {
  await evaluate(page, `window.setCaption(${JSON.stringify(caption)}, ${JSON.stringify(stamp)})`);
  await sleep(120);
  const { data } = await page.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  const { width, height } = pngSize(fs.readFileSync(file));
  console.log(`  ${path.relative(ROOT, file)} — ${width}x${height}`);
  if (width !== W || height !== H) throw new Error(`${name}: expected ${W}x${H}`);
}

/** Read PNG dimensions without a dependency (IHDR is at a fixed offset). */
function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function main() {
  const build = JSON.parse(fs.readFileSync(path.join(DIST, "build.json"), "utf8"));
  const stamp = `${build.version}+${build.stamp}`;
  fs.mkdirSync(OUT, { recursive: true });

  const server = await serve();
  const port = server.address().port;
  const chromePort = 9800 + Math.floor(Math.random() * 100);
  const { child } = await launchChrome({
    port: chromePort,
    extraArgs: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, `--window-size=${W},${H}`, "--force-device-scale-factor=1"],
  });
  let page;
  try {
    page = await openPage(chromePort, `http://127.0.0.1:${port}/`);
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: W, height: H, deviceScaleFactor: 1, mobile: false,
    });
    await waitFor(page, "!!document.getElementById('body')", 8000);
    // The demo page focuses the field on load; if the content script had not been
    // injected yet, that focus was missed — focus again, which is what a user does.
    await evaluate(page, "document.getElementById('body').focus()");
    const attached = await waitFor(page, "document.getElementById('body').hasAttribute('data-jsbarevi-active')", 5000);
    if (!attached) throw new Error("engine did not attach — is dist/ built?");

    await shot(page, "01-normal", "NORMAL mode in any text field · block caret · hjkl", stamp);

    await typeKeys(page, "Vjj");
    await shot(page, "02-visual", "VISUAL LINE · the selection is drawn by the editor", stamp);

    await typeKeys(page, "<Esc>:s/quick/brisk/g");
    await shot(page, "03-command-line", "The : line · ex commands with ranges and real regex", stamp);

    await typeKeys(page, "<Esc>GA");
    await typeKeys(page, " Ping me if the batch slips.<Esc>");
    await typeKeys(page, "i");
    await shot(page, "04-insert", "INSERT stays the browser's · typing, IME and paste", stamp);

    console.log(`  ${stamp}`);
  } finally {
    try { page?.close(); } catch { /* ignore */ }
    child.kill("SIGKILL");
    server.close();
  }
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
