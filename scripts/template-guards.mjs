#!/usr/bin/env node
// Two guards for a verify cell, as pure functions plus a small CLI.
//
//   runtime-version <sato.template.json>   print runtime.version (the Node
//                                          major setup-node installs)
//   check-node <sato.template.json>        fail when the running Node major
//                                          differs from runtime.version
//   check-tests <test.log> [<count-file>]  fail when the test log reports 0
//                                          tests (or no count at all); writes
//                                          the count to <count-file>

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function declaredNodeVersion(manifest) {
  const v = manifest?.runtime?.version;
  if (manifest?.runtime?.kind && manifest.runtime.kind !== "node") throw new Error(`runtime.kind is ${manifest.runtime.kind}, not node`);
  if (typeof v !== "string" || !/^\d+(\.\d+){0,2}$/.test(v.trim())) throw new Error(`runtime.version missing or not a Node version: ${JSON.stringify(v)}`);
  return v.trim();
}

export function nodeMajorMismatch(declared, actual) {
  const d = String(declared).replace(/^v/, "").split(".")[0];
  const a = String(actual).replace(/^v/, "").split(".")[0];
  return d === a ? null : `template declares Node ${d} (runtime.version), but this cell runs Node ${a}`;
}

// node --test prints "# tests N" (tap) or "ℹ tests N" (spec). The last
// summary line wins; null when the log carries none.
export function countTests(log) {
  const re = /^\s*(?:#|ℹ)\s*tests\s+(\d+)\s*$/gm;
  let m, n = null;
  while ((m = re.exec(String(log)))) n = Number(m[1]);
  return n;
}

export function testCountProblem(n) {
  if (n === null) return "no test summary found in the test log; cannot confirm any test ran";
  if (n === 0) return "0 tests ran; a run with no tests is not a pass";
  return null;
}

function main([cmd, file, extra]) {
  if (cmd === "runtime-version") { console.log(declaredNodeVersion(JSON.parse(readFileSync(file, "utf8")))); return 0; }
  if (cmd === "check-node") {
    const p = nodeMajorMismatch(declaredNodeVersion(JSON.parse(readFileSync(file, "utf8"))), process.versions.node);
    if (p) { console.error(p); return 1; }
    console.log(`Node ${process.versions.node} matches runtime.version`); return 0;
  }
  if (cmd === "check-tests") {
    const n = countTests(readFileSync(file, "utf8"));
    if (extra) writeFileSync(extra, JSON.stringify(n));
    const p = testCountProblem(n);
    if (p) { console.error(p); return 1; }
    console.log(`${n} tests ran`); return 0;
  }
  console.error("usage: template-guards.mjs runtime-version|check-node|check-tests <file> [count-file]"); return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.exit(main(process.argv.slice(2))); } catch (e) { console.error(e.message); process.exit(1); }
}
