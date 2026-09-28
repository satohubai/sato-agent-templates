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
//
// Framework rule: a direct dependency is moved to its newest version only as
// far as the template's framework accepts it. Two kinds of declared range count:
//   - a peer range on it from ANY package in the resolved tree
//     (peerDependencies, optional peers included: npm enforces those whenever
//     the package is present, so breaking one is an ERESOLVE at `npm ci`);
//   - a dependency range on it from another DIRECT dependency (the template's
//     framework), so the template and its framework keep sharing one copy.
// When @latest falls outside any of those ranges, the lane takes the newest
// published version that satisfies all of them and logs which package held it.
// Forcing past them tests npm's resolver or a duplicated copy, not the
// template. Seen 2026-09-28 on base-guarded-trader/agentkit: typescript@7
// broke @solana/kit's peerOptional typescript@^5 (install failed), and viem
// @latest beside @coinbase/agentkit's exact viem@2.38.3 gave two viem copies
// whose Client types do not match (typecheck failed).

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

/**
 * Pure: every range the resolved tree declares on direct dependency `name`:
 * peer ranges from any package, plus dependency ranges from the other direct
 * dependencies (`direct`: their names). Root excluded; duplicates collapsed.
 */
export function peerRanges(lock, name, direct = []) {
  const seen = new Map();
  for (const [path, meta] of Object.entries(lock?.packages ?? {})) {
    if (!path) continue;
    const from = path.replace(/^.*node_modules\//, "");
    const isDirect = path === `node_modules/${from}` && direct.includes(from) && from !== name;
    for (const range of [meta?.peerDependencies?.[name], isDirect ? meta?.dependencies?.[name] : undefined]) {
      // "*" / "x" / "" accept every version (and `npm view pkg@*` answers only latest).
      if (range && !/^\s*(\*|x|X)?\s*$/.test(range)) seen.set(`${from} ${range}`, { from, range });
    }
  }
  return [...seen.values()].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.range < b.range ? -1 : 1));
}

/**
 * Pure: the newest version allowed by every range. `ordered` is the package's
 * published versions oldest→newest, capped at the dist-tag latest; `allowed` is
 * one list per range (the versions that range accepts). null when none fits.
 */
export function newestAllowed(ordered, allowed) {
  const sets = allowed.map((l) => new Set(l));
  for (let i = ordered.length - 1; i >= 0; i--) if (sets.every((s) => s.has(ordered[i]))) return ordered[i];
  return null;
}

const viewCache = new Map();
function npmView(spec, field) {
  const key = `${spec} ${field}`;
  if (!viewCache.has(key)) viewCache.set(key, npmViewUncached(spec, field));
  return viewCache.get(key);
}

function npmViewUncached(spec, field) {
  try {
    const out = execFileSync("npm", ["view", spec, field, "--json", `--registry=${REGISTRY}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 }).trim();
    if (!out) return [];
    const v = JSON.parse(out);
    return Array.isArray(v) ? v : [v];
  } catch { return []; }
}

/** Moves any direct dependency that breaks a peer range back to the newest version all ranges accept. */
function respectPeers(pkg, inject) {
  const held = [];
  for (let round = 0; round < 3; round++) {
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    const fixes = { dependencies: [], devDependencies: [] };
    for (const group of ["dependencies", "devDependencies"]) {
      for (const [name, spec] of Object.entries(pkg[group] ?? {})) {
        if (String(spec).startsWith("file:") || (inject && inject.name === name)) continue;
        const current = lock.packages?.[`node_modules/${name}`]?.version;
        const direct = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
        const ranges = peerRanges(lock, name, direct);
        if (!current || !ranges.length) continue;
        const allowed = ranges.map((r) => npmView(`${name}@${r.range}`, "version"));
        if (allowed.every((l) => l.includes(current))) continue;
        const latest = npmView(`${name}@latest`, "version")[0];
        const all = npmView(name, "versions");
        const ordered = latest && all.includes(latest) ? all.slice(0, all.indexOf(latest) + 1) : all;
        const pick = newestAllowed(ordered, allowed);
        const all_blockers = [...new Set(ranges.filter((_, i) => !allowed[i].includes(current)).map((r) => `${r.from} wants ${r.range}`))];
        const blockers = all_blockers.length > 4 ? [...all_blockers.slice(0, 4), `${all_blockers.length - 4} more`] : all_blockers;
        if (!pick || pick === current) { console.log(`framework rule: ${name}@${current} breaks ${blockers.join("; ")} and no published version satisfies every range; left as is`); continue; }
        console.log(`framework rule: holding ${name} at ${pick} instead of ${current} (${blockers.join("; ")})`);
        held.push({ name, from: current, to: pick, because: blockers });
        fixes[group].push(`${name}@${pick}`);
      }
    }
    if (!fixes.dependencies.length && !fixes.devDependencies.length) break;
    for (const [group, dev] of [["dependencies", false], ["devDependencies", true]]) {
      if (!fixes[group].length) continue;
      const args = npmArgs(fixes[group], dev);
      console.log(`npm ${args.join(" ")}`);
      execFileSync("npm", args, { stdio: "inherit" });
    }
  }
  return held;
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
  respectPeers(pkg, inject);
  const after = JSON.parse(readFileSync("package.json", "utf8"));
  console.log(`resolved: ${JSON.stringify({ ...after.dependencies, ...after.devDependencies })}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
