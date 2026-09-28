#!/usr/bin/env node
// The latest lane: before `npm ci`, move every non-vendored dependency of the
// template in the current directory to its newest published version, from
// registry.npmjs.org only, with install scripts off. package.json and
// package-lock.json are rewritten in the runner's checkout only; the pinned
// lane never sees them.
//
//   node scripts/resolve-latest.mjs [--inject <pkg>@<version>]
//
// --inject (the drift drill) forces one package to a named version instead of
// latest, so the break path can be exercised on demand.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const REGISTRY = "https://registry.npmjs.org/";
const INJECT_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@[0-9A-Za-z][0-9A-Za-z.+-]*$/;

export function parseInject(s) {
  if (!s) return null;
  if (!INJECT_RE.test(s)) throw new Error(`inject must be <pkg>@<version>, got ${JSON.stringify(s)}`);
  const at = s.lastIndexOf("@");
  return { name: s.slice(0, at), version: s.slice(at + 1) };
}

/** Pure: package.json (+ optional injection) → the install specs per group. */
export function planLatest(pkg, inject = null) {
  const plan = { dependencies: [], devDependencies: [], vendored: [] };
  let injected = false;
  for (const group of ["dependencies", "devDependencies"]) {
    for (const [name, spec] of Object.entries(pkg[group] ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (String(spec).startsWith("file:")) { plan.vendored.push(name); continue; }
      if (inject && inject.name === name) { plan[group].push(`${name}@${inject.version}`); injected = true; }
      else plan[group].push(`${name}@latest`);
    }
  }
  if (inject && !injected) throw new Error(`inject names ${inject.name}, which is not a non-vendored dependency of ${pkg.name}`);
  return plan;
}

export function npmArgs(specs, dev) {
  return ["install", ...specs, dev ? "--save-dev" : "--save-prod", "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${REGISTRY}`];
}

export function main(argv = process.argv.slice(2)) {
  const i = argv.indexOf("--inject");
  const inject = parseInject(i >= 0 ? argv[i + 1] : process.env.INJECT_DRIFT || "");
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const plan = planLatest(pkg, inject);
  if (inject) console.log(`drift drill: forcing ${inject.name}@${inject.version}`);
  for (const [group, dev] of [["dependencies", false], ["devDependencies", true]]) {
    if (!plan[group].length) continue;
    const args = npmArgs(plan[group], dev);
    console.log(`npm ${args.join(" ")}`);
    execFileSync("npm", args, { stdio: "inherit" });
  }
  const after = JSON.parse(readFileSync("package.json", "utf8"));
  console.log(`resolved: ${JSON.stringify({ ...after.dependencies, ...after.devDependencies })}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
