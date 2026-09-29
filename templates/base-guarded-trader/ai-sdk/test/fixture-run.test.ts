// End to end: the default command a generated repo is judged by.
// Depends on the kit's real implementation (actions, pre-flight, intents).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("npm start -- --mode fixture exits 0 and shows a named refusal", () => {
  const out = mkdtempSync(join(tmpdir(), "bgt-"));
  const r = spawnSync("npm", ["start", "--silent", "--", "--mode", "fixture", "--out", out], { encoding: "utf8", timeout: 120_000, env: { ...process.env, ANVIL_RPC_URL: "", AI_GATEWAY_API_KEY: "" } });
  const text = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 0, text);
  assert.match(text, /REFUSED rule=max_usd_per_trade limit=\S+ observed=\S+/);
  assert.match(text, /enforcement lives in the signer/);
  const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
  const demo = report.intents.find((i: { demo_refusal: boolean }) => i.demo_refusal);
  assert.equal(demo.policy_ok, false);
  assert.ok(demo.refusals.every((x: { rule: string; limit: string; observed: string }) => x.rule && x.limit && x.observed));
  assert.equal(report.executed, false);
  assert.equal(report.model, "scripted-turns/1");
  assert.equal(report.host.framework, "ai-sdk");
  assert.deepEqual(report.host.calls, ["swap_quote", "swap_prepare", "swap_quote", "swap_prepare", "execute"]);
  const exec = report.host.approvals.find((a: { tool: string }) => a.tool === "execute");
  assert.equal(exec.gate, "approval-requested");
  assert.equal(exec.approved, false);
  assert.match(text, /no model API is called/);
});
