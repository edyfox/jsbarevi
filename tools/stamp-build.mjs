#!/usr/bin/env node
// Write src/build-info.js with the current commit, so a cached page is
// distinguishable from a broken one: the UI prints this string, `:version` reports
// it, and the dev server overrides it per request (see tools/dev-server.mjs).
import fs from "node:fs";
import path from "node:path";
import { currentBuild, buildInfoSource, buildInfoPath } from "./build-id.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const build = currentBuild({ cwd: ROOT });
fs.writeFileSync(buildInfoPath(ROOT), buildInfoSource(build));
console.log("build stamp:", build.stamp);
