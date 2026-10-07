// End to end: the default command a generated repo is judged by.
// Depends on the kit's real implementation (actions, pre-flight, intents).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GENERATED } from "./goal-bound.js";

test("npm start -- --mode fixture exits 0 and shows a named refusal", () => {
  const out = mkdtempSync(join(tmpdir(), "bgt-"));
  const r = spawnSync("npm", ["start", "--silent", "--", "--mode", "fixture", "--out", out], { encoding: "utf8", timeout: 120_000, env: { ...process.env, ANVIL_RPC_URL: "", OPENAI_API_KEY: "" } });
  const text = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 0, text);
  assert.match(text, /REFUSED rule=max_usd_per_trade limit=\S+ observed=\S+/);
  assert.match(text, /enforcement lives in the signer/);
  const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
  const demo = report.intents.find((i: { demo_refusal: boolean }) => i.demo_refusal);
  assert.equal(demo.policy_ok, false);
  assert.ok(demo.refusals.every((x: { rule: string; limit: string; observed: string }) => x.rule && x.limit && x.observed));
  assert.equal(report.executed, false);
  // The agent asks to execute only once its own intent passed the pre-flight. Under a user's cap
  // below its 10 USDC trade (a generated repo) that intent is refused, so the run stops short of it.
  const own = report.intents.find((i: { demo_refusal: boolean }) => !i.demo_refusal);
  if (!GENERATED) assert.equal(own.policy_ok, true);
  assert.equal(report.model, "scripted-turns/1");
  assert.equal(report.host.framework, "openai-agents");
  assert.deepEqual(report.host.calls, ["swap_quote", "swap_prepare", "swap_quote", "swap_prepare", ...(own.policy_ok ? ["execute"] : [])]);
  if (own.policy_ok) {
    const exec = report.host.approvals.find((a: { tool: string }) => a.tool === "execute");
    assert.equal(exec.gate, "interrupted");
    assert.equal(exec.approved, false);
  }
  assert.match(text, /no model API is called/);
});
