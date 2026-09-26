#!/usr/bin/env node
// Folds tonight's per-cell result files into status.json and writes one
// shields.io endpoint badge per template × framework.
//
//   node scripts/update-status.mjs --results <dir> --status status.json \
//     --badges badges --date YYYY-MM-DD [--expect t/f/lane,...]
//
// A cell that was expected but left no result file is recorded as "error"
// with failing_step "no_result", so a job that died early never reads as
// green. last_green only ever moves on a green run.

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const STATUS_SCHEMA = "sato.template-status/v1";
export const HISTORY_MAX = 30;
const RESULTS = new Set(["green", "red", "error"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function cellId(c) {
  return `${c.template}/${c.framework}/${c.lane}`;
}

/** Normalise one result file; throws on anything malformed rather than guessing. */
export function parseResult(r) {
  for (const k of ["template", "framework", "lane"]) {
    if (typeof r?.[k] !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(r[k])) throw new Error(`result.${k} is missing or malformed`);
  }
  const result = RESULTS.has(r.result) ? r.result : "error";
  return {
    template: r.template,
    framework: r.framework,
    lane: r.lane,
    result,
    failing_step: result === "green" ? null : typeof r.failing_step === "string" ? r.failing_step : "unknown",
    log_excerpt: result === "green" ? null : typeof r.log_excerpt === "string" ? r.log_excerpt.slice(-8000) : null,
    resolved: r.resolved && typeof r.resolved === "object" && !Array.isArray(r.resolved) ? r.resolved : {},
  };
}

/** Pure: previous status + tonight's results → next status. */
export function applyResults(status, results, { date, expected = [] }) {
  if (!DATE_RE.test(date)) throw new Error(`date must be YYYY-MM-DD, got ${date}`);
  const cells = new Map((status?.cells ?? []).map((c) => [cellId(c), c]));
  const incoming = results.map(parseResult);
  const seen = new Set(incoming.map(cellId));
  for (const e of expected) {
    const [template, framework, lane] = e.split("/");
    const probe = { template, framework, lane };
    if (!seen.has(cellId(probe))) incoming.push(parseResult({ ...probe, result: "error", failing_step: "no_result", log_excerpt: "The verify job left no result file for this cell." }));
  }
  for (const r of incoming) {
    const prev = cells.get(cellId(r));
    const history = [...(prev?.history ?? []), { date, result: r.result }].slice(-HISTORY_MAX);
    cells.set(cellId(r), {
      template: r.template,
      framework: r.framework,
      lane: r.lane,
      last_run: date,
      last_green: r.result === "green" ? date : (prev?.last_green ?? null),
      result: r.result,
      failing_step: r.failing_step,
      log_excerpt: r.log_excerpt,
      resolved: Object.keys(r.resolved).length ? r.resolved : (prev?.resolved ?? {}),
      history,
    });
  }
  const sorted = [...cells.values()].sort((a, b) => (cellId(a) < cellId(b) ? -1 : 1));
  return { schema: STATUS_SCHEMA, cells: sorted };
}

/** shields.io endpoint badge for a template × framework, read off its pinned lane. */
export function badgeFor(cell) {
  const green = cell.result === "green";
  return {
    schemaVersion: 1,
    label: "last green",
    message: cell.last_green ?? "never",
    color: green ? "brightgreen" : cell.last_green ? "orange" : "red",
  };
}

export function badgesFor(status) {
  const out = {};
  for (const c of status.cells) {
    if (c.lane !== "pinned") continue;
    out[`${c.template}-${c.framework}.json`] = badgeFor(c);
  }
  return out;
}

function arg(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

export function main(argv = process.argv.slice(2)) {
  const resultsDir = arg(argv, "--results", "results");
  const statusPath = arg(argv, "--status", "status.json");
  const badgesDir = arg(argv, "--badges", "badges");
  const date = arg(argv, "--date", new Date().toISOString().slice(0, 10));
  const expected = arg(argv, "--expect", "").split(",").map((s) => s.trim()).filter(Boolean);
  const prev = existsSync(statusPath) ? JSON.parse(readFileSync(statusPath, "utf8")) : { schema: STATUS_SCHEMA, cells: [] };
  const files = existsSync(resultsDir) ? readdirSync(resultsDir, { recursive: true }).filter((f) => String(f).endsWith(".json")) : [];
  const results = files.map((f) => JSON.parse(readFileSync(join(resultsDir, String(f)), "utf8")));
  const next = applyResults(prev, results, { date, expected });
  writeFileSync(statusPath, JSON.stringify(next, null, 2) + "\n");
  mkdirSync(badgesDir, { recursive: true });
  for (const [file, badge] of Object.entries(badgesFor(next))) writeFileSync(join(badgesDir, file), JSON.stringify(badge, null, 2) + "\n");
  for (const c of next.cells) console.log(`${cellId(c)}: ${c.result}${c.failing_step ? ` (${c.failing_step})` : ""}, last green ${c.last_green ?? "never"}`);
  return next;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
