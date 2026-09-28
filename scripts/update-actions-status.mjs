#!/usr/bin/env node
// Folds tonight's per-action result files (scripts/check-actions.mjs) into
// actions-status.json (sato.action-status/v1).
//
//   node scripts/update-actions-status.mjs --results <dir> \
//     --status actions-status.json --date YYYY-MM-DD [--expect id,id,...]
//
// green = the conformance check passed. Schema-lint findings and description
// drift are reported beside it, never a failure. A red names the failing step
// and the upstream version it ran against. An expected action that left no
// result is "error" with failing_step "no_result"; a run that failed on our
// side (no fork, fork read failed) is "error", never "red". last_green only
// moves on a green run; history keeps the last 30 runs. Each action carries
// the chain its check reads (`chain`, additive to v1; null when a record
// predates it).

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const ACTION_STATUS_SCHEMA = "sato.action-status/v1";
export const HISTORY_MAX = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[a-z0-9-]+:[A-Za-z0-9._-]+$/;
const CHAIN_RE = /^[a-z0-9-]+$/;
const KINDS = new Set(["agentkit-provider", "protocol-mcp", "skill", "base-mcp-plugin", "sato-kit"]);
const EMPTY_LINT = { result: "not_run", hosts: { openai: [], cursor: [], claude: [] } };
const EMPTY_CUSTODY = { result: "not_run", answers: null, check_url: null };

function isObj(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const strOrNull = (v) => (typeof v === "string" && v ? v : null);

/** Normalise one result record; throws on anything malformed rather than guessing. */
export function parseRecord(r) {
  if (!ID_RE.test(r?.id ?? "")) throw new Error(`record.id is missing or malformed: ${JSON.stringify(r?.id)}`);
  if (typeof r.name !== "string" || !r.name) throw new Error(`record.name is missing for ${r.id}`);
  if (!isObj(r.source) || !KINDS.has(r.source.kind)) throw new Error(`record.source.kind is missing or unknown for ${r.id}`);
  const conf = isObj(r.checks?.conformance) ? r.checks.conformance : {};
  const confResult = ["pass", "fail", "not_run"].includes(conf.result) ? conf.result : "not_run";
  const lint = isObj(r.checks?.schema_lint) && ["pass", "findings", "not_run"].includes(r.checks.schema_lint.result) ? r.checks.schema_lint : EMPTY_LINT;
  const custody = isObj(r.checks?.custody) && ["answered", "unknown", "not_run"].includes(r.checks.custody.result) ? r.checks.custody : EMPTY_CUSTODY;
  return {
    id: r.id,
    name: r.name,
    chain: typeof r.chain === "string" && CHAIN_RE.test(r.chain) ? r.chain : null,
    source: { kind: r.source.kind, package: String(r.source.package ?? ""), version: strOrNull(r.source.version), repo_url: strOrNull(r.source.repo_url) },
    conformance: { result: confResult, step: confResult === "pass" ? null : strOrNull(conf.step) ?? "unknown", detail: confResult === "pass" ? null : strOrNull(conf.detail)?.slice(0, 600) ?? null },
    schema_lint: { result: lint.result, hosts: { openai: lint.hosts?.openai ?? [], cursor: lint.hosts?.cursor ?? [], claude: lint.hosts?.claude ?? [] }, ...(Array.isArray(lint.portable) ? { portable: lint.portable } : {}) },
    custody: { result: custody.result, answers: custody.answers ?? null, check_url: strOrNull(custody.check_url) },
    digest: typeof r.description_digest === "string" && /^sha256:[0-9a-f]{64}$/.test(r.description_digest) ? r.description_digest : null,
    upstream_version: strOrNull(r.upstream_version) ?? strOrNull(r.source.version),
    run_error: strOrNull(r.run_error),
  };
}

export function drift(prevCheck, digest) {
  const previous = prevCheck?.digest ?? prevCheck?.previous_digest ?? null;
  if (digest === null) return { result: "not_run", digest: null, previous_digest: previous };
  if (previous === null) return { result: "first_seen", digest, previous_digest: null };
  return { result: previous === digest ? "unchanged" : "changed", digest, previous_digest: previous };
}

export function resultFor(rec) {
  if (rec.conformance.result === "pass") return "green";
  if (rec.run_error || rec.conformance.result === "not_run") return "error";
  return "red";
}

/** Pure: previous status + tonight's records → next status. */
export function applyActionResults(status, records, { date, expected = [] }) {
  if (!DATE_RE.test(date)) throw new Error(`date must be YYYY-MM-DD, got ${date}`);
  const byId = new Map((status?.actions ?? []).map((a) => [a.id, a]));
  const incoming = records.map(parseRecord);
  const seen = new Set(incoming.map((r) => r.id));
  const next = new Map(byId);

  for (const r of incoming) {
    const prev = byId.get(r.id);
    const result = resultFor(r);
    const history = [...(prev?.history ?? []), { date, result }].slice(-HISTORY_MAX);
    next.set(r.id, {
      id: r.id,
      name: r.name,
      chain: r.chain ?? prev?.chain ?? null,
      source: r.source,
      checks: {
        conformance: r.conformance,
        schema_lint: r.schema_lint,
        custody: r.custody,
        description_drift: drift(prev?.checks?.description_drift, r.digest),
      },
      result,
      failing_step: result === "green" ? null : r.conformance.step,
      upstream_version: r.upstream_version,
      last_run: date,
      last_green: result === "green" ? date : (prev?.last_green ?? null),
      history,
    });
  }
  for (const id of expected) {
    if (seen.has(id)) continue;
    const prev = byId.get(id);
    if (!prev) continue; // never recorded: nothing to say about it yet
    next.set(id, {
      ...prev,
      checks: { ...prev.checks, conformance: { result: "not_run", step: "no_result", detail: "The check job left no result for this action." } },
      result: "error",
      failing_step: "no_result",
      last_run: date,
      history: [...(prev.history ?? []), { date, result: "error" }].slice(-HISTORY_MAX),
    });
  }
  const actions = [...next.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { schema: ACTION_STATUS_SCHEMA, updated: date, actions };
}

function arg(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

export async function main(argv = process.argv.slice(2)) {
  const resultsDir = arg(argv, "--results", "action-results");
  const statusPath = arg(argv, "--status", "actions-status.json");
  const date = arg(argv, "--date", new Date().toISOString().slice(0, 10));
  let expected = arg(argv, "--expect", "").split(",").map((s) => s.trim()).filter(Boolean);
  if (expected.length === 1 && expected[0] === "catalog") expected = (await import("./actions-catalog.mjs")).ACTIONS.map((a) => a.id);
  const prev = existsSync(statusPath) ? JSON.parse(readFileSync(statusPath, "utf8")) : { schema: ACTION_STATUS_SCHEMA, updated: null, actions: [] };
  const files = existsSync(resultsDir) ? readdirSync(resultsDir, { recursive: true }).filter((f) => String(f).endsWith(".json")) : [];
  const records = files.map((f) => JSON.parse(readFileSync(join(resultsDir, String(f)), "utf8")));
  const next = applyActionResults(prev, records, { date, expected });
  writeFileSync(statusPath, JSON.stringify(next, null, 2) + "\n");
  for (const a of next.actions) console.log(`${a.id} [${a.chain ?? "?"}]: ${a.result}${a.failing_step ? ` (${a.failing_step} @ ${a.upstream_version ?? "unknown version"})` : ""}, last green ${a.last_green ?? "never"}`);
  return next;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
