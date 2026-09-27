import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTION_STATUS_SCHEMA, HISTORY_MAX, applyActionResults, drift, parseRecord } from "./update-actions-status.mjs";

const empty = { schema: ACTION_STATUS_SCHEMA, updated: null, actions: [] };
const D1 = `sha256:${"a".repeat(64)}`;
const D2 = `sha256:${"b".repeat(64)}`;
const base = {
  id: "protocol-mcp:evm-mcp-server.get_block",
  name: "get_block",
  source: { kind: "protocol-mcp", package: "@mcpdotdirect/evm-mcp-server", version: "2.0.4", repo_url: "https://github.com/mcpdotdirect/evm-mcp-server" },
  upstream_version: "2.0.4",
  checks: {
    conformance: { result: "pass", step: null, detail: null },
    schema_lint: { result: "findings", hosts: { openai: [{ rule: "name_charset", message: "x" }], cursor: [], claude: [] }, portable: [] },
    custody: { result: "unknown", answers: { takes_key: "unknown", key_leaves: "unknown", moves_funds: "unknown" }, check_url: "https://satohub.ai/check/x" },
  },
  description_digest: D1,
};
const green = base;
const red = { ...base, upstream_version: "2.1.0", checks: { ...base.checks, conformance: { result: "fail", step: "assert", detail: "hash differs" } } };

test("green = conformance pass; lint findings do not make it red", () => {
  const s = applyActionResults(empty, [green], { date: "2026-09-26" });
  assert.equal(s.schema, ACTION_STATUS_SCHEMA);
  assert.equal(s.updated, "2026-09-26");
  const a = s.actions[0];
  assert.equal(a.result, "green");
  assert.equal(a.failing_step, null);
  assert.equal(a.last_green, "2026-09-26");
  assert.equal(a.checks.schema_lint.result, "findings");
  assert.equal(a.checks.description_drift.result, "first_seen");
});

test("a red names the step and the upstream version, and keeps last_green", () => {
  const s1 = applyActionResults(empty, [green], { date: "2026-09-26" });
  const s2 = applyActionResults(s1, [red], { date: "2026-09-27" });
  const a = s2.actions[0];
  assert.equal(a.result, "red");
  assert.equal(a.failing_step, "assert");
  assert.equal(a.upstream_version, "2.1.0");
  assert.equal(a.last_green, "2026-09-26");
  assert.deepEqual(a.history.map((h) => h.result), ["green", "red"]);
});

test("description drift compares with the previous night", () => {
  const s1 = applyActionResults(empty, [green], { date: "2026-09-26" });
  const s2 = applyActionResults(s1, [green], { date: "2026-09-27" });
  assert.equal(s2.actions[0].checks.description_drift.result, "unchanged");
  const s3 = applyActionResults(s2, [{ ...green, description_digest: D2 }], { date: "2026-09-28" });
  assert.deepEqual(s3.actions[0].checks.description_drift, { result: "changed", digest: D2, previous_digest: D1 });
  // drift alone is not a failure
  assert.equal(s3.actions[0].result, "green");
});

test("an unreadable description keeps the last digest to compare against", () => {
  assert.deepEqual(drift({ digest: D1 }, null), { result: "not_run", digest: null, previous_digest: D1 });
  assert.deepEqual(drift({ result: "not_run", digest: null, previous_digest: D1 }, D1), { result: "unchanged", digest: D1, previous_digest: D1 });
});

test("a failure on our side is error, never red", () => {
  const ours = { ...red, run_error: "no_fork", checks: { ...red.checks, conformance: { result: "fail", step: "no_fork", detail: "no rpc" } } };
  assert.equal(applyActionResults(empty, [ours], { date: "2026-09-26" }).actions[0].result, "error");
  const notRun = { ...base, checks: { ...base.checks, conformance: { result: "not_run", step: "no_call" } } };
  assert.equal(applyActionResults(empty, [notRun], { date: "2026-09-26" }).actions[0].result, "error");
});

test("an expected action with no result tonight is error/no_result and keeps last_green", () => {
  const s1 = applyActionResults(empty, [green], { date: "2026-09-26" });
  const s2 = applyActionResults(s1, [], { date: "2026-09-27", expected: [green.id, "skill:never.seen"] });
  assert.equal(s2.actions.length, 1);
  assert.equal(s2.actions[0].result, "error");
  assert.equal(s2.actions[0].failing_step, "no_result");
  assert.equal(s2.actions[0].last_green, "2026-09-26");
});

test("history keeps the last 30 runs; actions are sorted by id", () => {
  let s = empty;
  const other = { ...green, id: "agentkit-provider:erc20.get_balance", name: "ERC20ActionProvider_get_balance", source: { ...green.source, kind: "agentkit-provider" } };
  for (let i = 1; i <= 40; i++) s = applyActionResults(s, [i % 2 ? green : red, other], { date: `2026-10-${String((i % 28) + 1).padStart(2, "0")}` });
  assert.equal(s.actions.find((a) => a.id === green.id).history.length, HISTORY_MAX);
  assert.deepEqual(s.actions.map((a) => a.id), [other.id, green.id]);
});

test("malformed records and dates are refused", () => {
  assert.throws(() => parseRecord({ ...green, id: "../x" }));
  assert.throws(() => parseRecord({ ...green, source: { kind: "random" } }));
  assert.throws(() => applyActionResults(empty, [green], { date: "yesterday" }));
});

test("the file carries no counts and never the word safe", () => {
  const s = applyActionResults(empty, [green, red], { date: "2026-09-26" });
  const text = JSON.stringify(s);
  assert.doesNotMatch(text, /\b(safe|secure|count|total)\b/i);
});
