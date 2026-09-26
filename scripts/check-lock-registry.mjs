#!/usr/bin/env node
// Refuses a lockfile that resolves any package from anywhere but the npm
// registry or the template's own vendor/ directory. Run before `npm ci`.
import { readFileSync } from "node:fs";
const lock = JSON.parse(readFileSync(process.argv[2] || "package-lock.json", "utf8"));
const bad = [];
for (const [path, p] of Object.entries(lock.packages ?? {})) {
  if (!path || p.link) continue;
  const r = p.resolved;
  if (!r) continue;
  if (r.startsWith("https://registry.npmjs.org/") || r.startsWith("file:vendor/")) continue;
  bad.push(`${path} -> ${r}`);
}
if (bad.length) {
  console.error(`package-lock.json resolves outside the npm registry:\n${bad.join("\n")}`);
  process.exit(1);
}
console.log("lockfile: every package resolves from registry.npmjs.org or vendor/");
