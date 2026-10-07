// End to end: the default command a generated repo is judged by.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("npm start -- --mode fixture prints replies and one named refusal, with no tokens set", () => {
  const out = mkdtempSync(join(tmpdir(), "persona-"));
  const env = { ...process.env, TELEGRAM_BOT_TOKEN: "", DISCORD_BOT_TOKEN: "", ANTHROPIC_API_KEY: "", ANVIL_RPC_URL: "" };
  const r = spawnSync("npm", ["start", "--silent", "--", "--mode", "fixture", "--out", out], { encoding: "utf8", timeout: 120_000, env });
  const text = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 0, text);
  assert.match(text, /\[telegram\] Mira: gm ada/);
  assert.match(text, /\[discord\] Mira: Here is what I have: "my agent watches treasury balances/);
  assert.match(text, new RegExp(`REFUSED rule=max_usd_per_trade limit=${JSON.parse(readFileSync("policy.json", "utf8")).max_usd_per_trade} observed=1000`));
  assert.match(text, /enforcement lives in the signer/);
  const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
  assert.equal(report.schema, "persona-agent.report/v1");
  assert.equal(report.exchanges.length, 4);
  assert.ok(report.refused_intents >= 1);
  assert.equal(report.executed, false);
  const refused = report.exchanges.flatMap((e: { wallet: { policy_ok?: boolean; refusals?: { rule: string; limit: string; observed: string }[] }[] }) => e.wallet).find((w: { policy_ok?: boolean }) => w.policy_ok === false);
  assert.ok(refused.refusals.every((x: { rule: string; limit: string; observed: string }) => x.rule && x.limit && x.observed));
  // The memory store grew by one user line and one agent line per message.
  const lines = readFileSync(join(out, "memory.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2 + 8);
});

test("two fixture runs give the same replies", () => {
  const run = () => {
    const out = mkdtempSync(join(tmpdir(), "persona-"));
    const r = spawnSync("npm", ["start", "--silent", "--", "--mode", "fixture", "--out", out], { encoding: "utf8", timeout: 120_000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(readFileSync(join(out, "report.json"), "utf8")).exchanges.map((e: { reply: string }) => e.reply.replace(/si_[A-Za-z0-9_-]{43}/g, "si_"));
  };
  assert.deepEqual(run(), run());
});
