import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createInfo, doctorInfo, NO_TEMPLATE } from "./journey-info.mjs";
import { applyResults, badgesFor, STATUS_SCHEMA } from "./update-status.mjs";

const empty = { schema: STATUS_SCHEMA, cells: [] };

test("create: a planned template names the cell", () => {
  const i = createInfo({ ok: true, template: { id: "base-guarded-trader", version: "0.1.0", digest: "sha256:ab", framework: "plain-ts" } });
  assert.equal(i.template, "base-guarded-trader");
  assert.equal(i.create.ok, true);
});

test("create: a missing endpoint is recorded with its HTTP status, as answered", () => {
  const i = createInfo({ ok: false, error: "bad_response", message: "unexpected response from https://satohub.ai/api/create (HTTP 404)" });
  assert.equal(i.template, NO_TEMPLATE);
  assert.deepEqual([i.create.ok, i.create.error, i.create.http_status], [false, "bad_response", 404]);
});

test("create: a refusal keeps its code and rule; no output is no_output", () => {
  const r = createInfo({ ok: false, error: "invalid_request", message: "unknown --framework nope", rule: "create.framework_unknown" });
  assert.deepEqual([r.create.error, r.create.rule, r.create.http_status], ["invalid_request", "create.framework_unknown", null]);
  assert.equal(createInfo(null).create.error, "no_output");
});

test("doctor: drift changes are info; only a missing answer is not ok", () => {
  const d = doctorInfo({ ok: true, result: { drift: { state: "checked", template: { pinned_version: "0.1.0", latest_version: "0.2.0" }, changes: [{ kind: "version" }] } } });
  assert.equal(d.ok, true);
  assert.equal(d.drift.changes.length, 1);
  assert.equal(doctorInfo(null).ok, false);
  assert.equal(doctorInfo({ ok: false }).ok, false);
});

test("update-status: a journey cell keeps its info, last_green and history, and gets no badge", () => {
  const cell = { template: "base-guarded-trader", framework: "plain-ts", lane: "journey" };
  const s1 = applyResults(empty, [{ ...cell, result: "green", info: { create: { ok: true }, doctor: { ok: true, drift: { state: "checked", changes: [] } } } }], { date: "2026-09-30" });
  const s2 = applyResults(s1, [{ ...cell, result: "red", failing_step: "test", info: { create: { ok: true } } }], { date: "2026-10-07" });
  const c = s2.cells[0];
  assert.equal(c.lane, "journey");
  assert.equal(c.last_green, "2026-09-30");
  assert.equal(c.failing_step, "test");
  assert.deepEqual(c.info, { create: { ok: true } });
  assert.equal(c.history.length, 2);
  assert.deepEqual(badgesFor(s2), {});
});

test("update-status: info is carried only on the journey lane", () => {
  const s = applyResults(empty, [{ template: "t", framework: "f", lane: "pinned", result: "green", info: { x: 1 } }], { date: "2026-09-30" });
  assert.equal("info" in s.cells[0], false);
});

test("journey.yml: weekly + dispatch, pinned actions, no secrets, status-branch writes only", () => {
  const t = readFileSync(".github/workflows/journey.yml", "utf8");
  assert.match(t, /schedule:\n\s+- cron: "[^"]+"/);
  assert.match(t, /workflow_dispatch:/);
  assert.match(t, /^permissions:\n\s+contents: read$/m);
  for (const m of t.matchAll(/uses:\s*(\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, `unpinned: ${m[1]}`);
  assert.doesNotMatch(t, /secrets\./);
  assert.match(t, /SATO_USER_AGENT: SatoHub-journey\/1\.0/);
  assert.match(t, /INTEGRATIONS_REF: [0-9a-f]{40}/);
  for (const step of ["create-sato-agent", "npm run typecheck", "npm test", "npm start -- --mode fixture", "doctor --json"]) assert.ok(t.includes(step), step);
  assert.match(t, /LANE: journey/);
  assert.match(t, /--status status-data\/status\.json/);
  assert.match(t, /pull --rebase origin status && git push origin HEAD:status/);
});
