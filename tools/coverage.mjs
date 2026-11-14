#!/usr/bin/env node
// Coverage sweep: run every suite, collect V8 block coverage, and report what never ran.
//
// Why this exists: `"+yaw` was fixed by a matrix, but the *class* of bug behind it —
// a rule that lives in one branch and is forgotten in a sibling — is a coverage
// question. A branch that never executes in any test is either dead code (delete it) or
// an untested path (test it). Both are findings; guessing which is which is what got us
// here.
//
//   node tools/coverage.mjs                 # run the suites, write .coverage/, print totals
//   node tools/coverage.mjs --only unit,differential
//   node tools/coverage.mjs --report        # re-use the last run, no suites executed
//
// V8 block coverage is used directly (NODE_V8_COVERAGE) rather than a dependency: the
// suite already runs every test file as its own process, and the JSON is precise about
// which RANGES executed, which is exactly the branch question.
//
// Browser-hosted suites (e2e, extension) run the same `src/` in Chrome, where a Node
// coverage hook cannot see them — so the engine is covered by the Node suites and the
// adapters are covered by the browser ones through their own assertions. This tool
// measures the former.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, ".coverage");
const COVERAGE_DIR = path.join(OUT, "raw");

/** The Node-hosted suites, in the order a human would debug them. */
const SUITES = {
  audit: ["tools/audit-undo.mjs"],
  unit: ["test/unit.mjs"],
  engine: ["test/run-engine-tests.mjs"],
  differential: ["test/differential.mjs"],
  matrix: ["test/registers-matrix.mjs"],
  cursor: ["test/cursor.mjs"],
  session: ["test/editor-session.mjs"],
};

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
const reuse = args.includes("--report");

function runSuites() {
  fs.rmSync(COVERAGE_DIR, { recursive: true, force: true });
  fs.mkdirSync(COVERAGE_DIR, { recursive: true });
  for (const [name, argv] of Object.entries(SUITES)) {
    if (only && !only.includes(name)) continue;
    // `--no-opt`: V8 block coverage loses a function's own counter when TurboFan
    // inlines it, so a one-line helper called from a hot switch reports as never
    // entered (`_shift`, behind `>>`, did exactly that). Without the optimiser the
    // data says what it means.
    const r = spawnSync(process.execPath, ["--no-opt", ...argv], {
      cwd: ROOT,
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, NODE_V8_COVERAGE: COVERAGE_DIR },
    });
    console.log(`  ${r.status === 0 ? "ok  " : "FAIL"} ${name}`);
    if (r.status !== 0) process.exitCode = 1;
  }
}

/** Merge every coverage-*.json into url -> [{start,end,count}] (outermost first per hit). */
function collect() {
  const files = fs.existsSync(COVERAGE_DIR)
    ? fs.readdirSync(COVERAGE_DIR).filter((f) => f.endsWith(".json"))
    : [];
  const ranges = new Map();     // url -> [{start, end, count}]
  for (const name of files) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(COVERAGE_DIR, name), "utf8")); } catch { continue; }
    for (const script of data.result || []) {
      if (!script.url || !script.url.startsWith("file://")) continue;
      const url = decodeURIComponent(script.url.replace("file://", ""));
      const list = ranges.get(url) || [];
      for (const fn of script.functions || []) {
        const span = (fn.ranges || [])[0] || null;
        for (const r of fn.ranges || []) {
          list.push({
            start: r.startOffset, end: r.endOffset, count: r.count, name: fn.functionName,
            fnStart: span ? span.startOffset : 0, fnEnd: span ? span.endOffset : 0,
          });
        }
      }
      ranges.set(url, list);
    }
  }
  return ranges;
}

/**
 * Report unexecuted BLOCKS rather than per-line guesses.
 *
 * V8 emits, for every function, a zero-count range covering the parameter list — so a
 * per-line "innermost range" rule marks `submitPrompt(value) {` as never executed even
 * when it ran 18 times. The block question is the one that matters anyway: which spans
 * of code never ran. Zero-count ranges are maximal-unexecuted when no other zero-count
 * range contains them, which is what "a branch nobody took" looks like.
 */
const snippetOf = (source, start, end) => source.slice(start, end).replace(/\s+/g, " ").trim().slice(0, 150);

function report(ranges) {
  const files = [...ranges.keys()]
    .filter((f) => f.startsWith(ROOT) && f.includes("/src/"))
    .sort();
  const rows = [];
  const blocks = [];

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const lineStarts = [0];
    for (let i = 0; i < source.length; i++) if (source[i] === "\n") lineStarts.push(i + 1);
    const lineOf = (offset) => {
      let lo = 0, hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
      }
      return lo + 1;
    };

    const list = ranges.get(file);

    /**
     * Per FUNCTION, not per file: V8 gives a function's full span a count that can be 0
     * even when its body ran (the same quirk that made a per-line rule mark a called
     * function as dead). The function's effective count is the MAX over its ranges, and
     * a zero-count range is only interesting when it sits INSIDE a function that did run
     * — that is a branch nobody took.
     */
    const byFn = new Map();
    for (const r of list) {
      if (!r.fnStart && r.fnStart !== 0) continue;
      const key = `${r.name || "<anonymous>"}@${r.fnStart}`;
      const group = byFn.get(key) || { name: r.name || "<anonymous>", start: r.fnStart, end: r.fnEnd, ranges: [] };
      group.ranges.push(r);
      byFn.set(key, group);
    }

    let called = 0;
    for (const group of byFn.values()) {
      const eff = Math.max(...group.ranges.map((r) => r.count));
      if (eff > 0) called++;
      if (eff === 0) {
        // never entered at all
        blocks.push({ file: path.relative(ROOT, file), line: lineOf(group.start), fn: group.name, flat: snippetOf(source, group.start, group.end), kind: "function" });
        continue;
      }
      // entered: report zero-count ranges inside it that are not the span itself
      const inner = group.ranges.filter((r) => r.count === 0 && (r.end - r.start) < (group.end - group.start));
      for (const r of inner) {
        if (inner.some((o) => o !== r && o.start <= r.start && o.end >= r.end && (o.end - o.start) > (r.end - r.start))) continue;
        // Only MULTI-LINE unexecuted spans are real branches. V8 also emits zero-count
        // ranges for single expressions that are perfectly ordinary (`opts.x || null`),
        // and reporting those buries the signal — the first run of this tool produced
        // 921 "blocks", almost all of them that artefact.
        const raw = source.slice(r.start, r.end);
        if (!raw.includes("\n")) continue;
        blocks.push({ file: path.relative(ROOT, file), line: lineOf(r.start), fn: group.name, flat: snippetOf(source, r.start, r.end), kind: "branch" });
      }
    }
    rows.push({ file: path.relative(ROOT, file), covered: called, total: byFn.size, pct: byFn.size ? (called / byFn.size) * 100 : 100 });
  }

  const seen = new Set();
  const unique = blocks.filter((b) => {
    const key = `${b.file}:${b.line}:${b.kind}:${b.flat}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  blocks.length = 0;
  blocks.push(...unique);

  const md = ["# Coverage sweep", "", `Generated ${new Date().toISOString()}`, "",
    "## Function coverage (Node-hosted suites)", "", "| file | called | total | % |", "|---|---|---|---|"];
  for (const r of rows.sort((a, b) => a.pct - b.pct)) {
    md.push(`| \`${r.file}\` | ${r.covered} | ${r.total} | ${r.pct.toFixed(1)}% |`);
  }
  md.push("", `## Never-executed blocks (${blocks.length})`, "");
  let last = null;
  for (const b of blocks) {
    if (b.file !== last) { md.push("", `### \`${b.file}\``, ""); last = b.file; }
    md.push(`- **${b.line}** [${b.kind}] ${b.fn ? `\`${b.fn}\` ` : ""}${b.flat}`);
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "summary.md"), md.join("\n") + "\n");

  console.log("");
  for (const r of rows.sort((a, b) => a.pct - b.pct)) {
    console.log(`  ${r.pct.toFixed(1).padStart(5)}%  ${String(r.covered).padStart(3)}/${String(r.total).padEnd(3)} fns  ${r.file}`);
  }
  console.log(`\n  ${blocks.length} never-executed blocks -> ${path.relative(ROOT, path.join(OUT, "summary.md"))}`);
  return blocks;
}

if (!reuse) runSuites();
const findings = report(collect());
process.exit(process.exitCode || 0);
