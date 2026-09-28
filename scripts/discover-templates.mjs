#!/usr/bin/env node
// Lists every template cell from the repository itself: one per
// templates/<template>/<framework>/sato.template.json. A new template needs no
// workflow edit.
//
//   node scripts/discover-templates.mjs --lanes pinned,latest [--root .]
//     prints {"include":[{template,framework,lane},...]} for fromJSON
//   node scripts/discover-templates.mjs --lanes pinned --expect
//     prints the comma list update-status.mjs takes as --expect
//   node scripts/discover-templates.mjs --lanes pinned --changed <file>
//     only the cells a change touches (<file>: one changed path per line);
//     a change under .github/, scripts/ or to the root policy/package files
//     selects every cell

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const LANES = ["pinned", "latest"];
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Every templates/<t>/<f> directory holding a sato.template.json, sorted. */
export function discoverCells(root = ".") {
  const base = join(root, "templates");
  if (!existsSync(base)) return [];
  const out = [];
  for (const t of readdirSync(base).sort()) {
    if (!ID_RE.test(t) || !statSync(join(base, t)).isDirectory()) continue;
    for (const f of readdirSync(join(base, t)).sort()) {
      if (!ID_RE.test(f)) continue;
      if (existsSync(join(base, t, f, "sato.template.json"))) out.push({ template: t, framework: f });
    }
  }
  return out;
}

/** Paths whose change can affect every cell. */
export const FULL_RUN = [/^\.github\//, /^scripts\//, /^upgrade-policy\.json$/, /^package(-lock)?\.json$/];

/**
 * Pure: the cells a set of changed paths touches. A file under
 * templates/<t>/<f>/ selects that cell; a file directly under templates/<t>/
 * selects every framework of <t>; anything matching FULL_RUN selects all.
 */
export function selectCells(cells, changed) {
  const files = (changed ?? []).map((f) => String(f).trim()).filter(Boolean);
  if (files.some((f) => FULL_RUN.some((re) => re.test(f)))) return cells;
  return cells.filter((c) => files.some((f) => f.startsWith(`templates/${c.template}/${c.framework}/`) || (f.startsWith(`templates/${c.template}/`) && f.split("/").length === 3)));
}

export function matrixFor(cells, lanes) {
  for (const l of lanes) if (!LANES.includes(l)) throw new Error(`unknown lane ${l}`);
  const include = [];
  for (const c of cells) for (const lane of lanes) include.push({ ...c, lane });
  return { include };
}

export function expectList(matrix) {
  return matrix.include.map((c) => `${c.template}/${c.framework}/${c.lane}`).join(",");
}

function arg(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

export function main(argv = process.argv.slice(2)) {
  const lanes = arg(argv, "--lanes", "pinned").split(",").map((s) => s.trim()).filter(Boolean);
  let cells = discoverCells(arg(argv, "--root", "."));
  if (!cells.length) throw new Error("no templates/*/*/sato.template.json found");
  const changed = arg(argv, "--changed", "");
  if (changed) cells = selectCells(cells, readFileSync(changed, "utf8").split("\n"));
  const m = matrixFor(cells, lanes);
  console.log(argv.includes("--expect") ? expectList(m) : JSON.stringify(m));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
