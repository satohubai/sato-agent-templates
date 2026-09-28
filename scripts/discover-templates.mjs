#!/usr/bin/env node
// Lists every template cell from the repository itself: one per
// templates/<template>/<framework>/sato.template.json. A new template needs no
// workflow edit.
//
//   node scripts/discover-templates.mjs --lanes pinned,latest [--root .]
//     prints {"include":[{template,framework,lane},...]} for fromJSON
//   node scripts/discover-templates.mjs --lanes pinned --expect
//     prints the comma list update-status.mjs takes as --expect

import { existsSync, readdirSync, statSync } from "node:fs";
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
  const cells = discoverCells(arg(argv, "--root", "."));
  if (!cells.length) throw new Error("no templates/*/*/sato.template.json found");
  const m = matrixFor(cells, lanes);
  console.log(argv.includes("--expect") ? expectList(m) : JSON.stringify(m));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
