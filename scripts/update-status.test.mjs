import { test } from "node:test";
import assert from "node:assert/strict";
import { applyResults, badgeFor, badgesFor, HISTORY_MAX, STATUS_SCHEMA } from "./update-status.mjs";

const empty = { schema: STATUS_SCHEMA, cells: [] };
const cell = { template: "base-guarded-trader", framework: "plain-ts", lane: "pinned" };
const green = { ...cell, result: "green", failing_step: null, log_excerpt: "", resolved: { viem: "2.56.9" } };
const red = { ...cell, result: "red", failing_step: "fork_check", log_excerpt: "boom", resolved: { viem: "2.56.9" } };

test("a green run sets last_green to today", () => {
  const s = applyResults(empty, [green], { date: "2026-09-26" });
  assert.equal(s.schema, STATUS_SCHEMA);
  assert.equal(s.cells.length, 1);
  assert.equal(s.cells[0].last_green, "2026-09-26");
  assert.equal(s.cells[0].failing_step, null);
  assert.deepEqual(s.cells[0].history, [{ date: "2026-09-26", result: "green" }]);
});

test("a red run keeps the previous last_green and names the failing step", () => {
  const s1 = applyResults(empty, [green], { date: "2026-09-26" });
  const s2 = applyResults(s1, [red], { date: "2026-09-27" });
  const c = s2.cells[0];
  assert.equal(c.result, "red");
  assert.equal(c.last_green, "2026-09-26");
  assert.equal(c.last_run, "2026-09-27");
  assert.equal(c.failing_step, "fork_check");
  assert.equal(c.log_excerpt, "boom");
});

test("never green stays null", () => {
  const s = applyResults(empty, [red], { date: "2026-09-26" });
  assert.equal(s.cells[0].last_green, null);
  assert.deepEqual(badgeFor(s.cells[0]), { schemaVersion: 1, label: "last green", message: "never", color: "red" });
});

test("history keeps the last 30 runs", () => {
  let s = empty;
  for (let i = 1; i <= 40; i++) s = applyResults(s, [i % 2 ? green : red], { date: `2026-10-${String((i % 28) + 1).padStart(2, "0")}` });
  assert.equal(s.cells[0].history.length, HISTORY_MAX);
});

test("an expected cell with no result file is an error, never green", () => {
  const s1 = applyResults(empty, [green], { date: "2026-09-26" });
  const s2 = applyResults(s1, [], { date: "2026-09-27", expected: ["base-guarded-trader/plain-ts/pinned"] });
  assert.equal(s2.cells[0].result, "error");
  assert.equal(s2.cells[0].failing_step, "no_result");
  assert.equal(s2.cells[0].last_green, "2026-09-26");
});

test("an unrecognised result value is recorded as error", () => {
  const s = applyResults(empty, [{ ...green, result: "passed" }], { date: "2026-09-26" });
  assert.equal(s.cells[0].result, "error");
});

test("malformed cells and dates are refused", () => {
  assert.throws(() => applyResults(empty, [{ ...green, template: "../x" }], { date: "2026-09-26" }));
  assert.throws(() => applyResults(empty, [green], { date: "yesterday" }));
});

test("badges: one per template-framework on the pinned lane", () => {
  const s = applyResults(empty, [green, { ...green, lane: "latest" }], { date: "2026-09-26" });
  const b = badgesFor(s);
  assert.deepEqual(Object.keys(b), ["base-guarded-trader-plain-ts.json"]);
  assert.equal(b["base-guarded-trader-plain-ts.json"].message, "2026-09-26");
  assert.equal(b["base-guarded-trader-plain-ts.json"].color, "brightgreen");
});
