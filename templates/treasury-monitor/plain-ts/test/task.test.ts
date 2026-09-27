import { test } from "node:test";
import assert from "node:assert/strict";
import { runTask, type BalanceSource, type MonitorInput } from "../src/task.js";

const A = "0x" + "1".repeat(40);
function stub(balances: Record<string, string>): BalanceSource {
  return {
    kind: "fixture",
    async balanceOf(chain, address, asset) {
      const v = balances[`${chain}|${address.toLowerCase()}|${asset.id}`];
      return v === undefined ? { ok: false, reason: "not recorded" } : { ok: true, base_units: v, chain: "base", block_number: "7" };
    },
  };
}
const input: MonitorInput = {
  now: "2026-01-01T00:00:00.000Z",
  assets: [{ id: "usdc", symbol: "USDC", decimals: 6, token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }],
  addresses: [{ label: "a", address: A, chain: 8453, assets: ["usdc"] }],
  thresholds: [{ chain: 8453, address: A, asset: "usdc", direction: "below", base_units: "100" }],
};

test("an unpriced holding stays null and blocks the total", async () => {
  const out = await runTask(input, stub({ [`8453|${A}|usdc`]: "5" }), "x");
  assert.equal(out.balances[0].value_usd, null);
  assert.equal(out.total_usd, null);
  assert.equal(out.unknowns[0].kind, "price_unavailable");
});

test("a threshold fires on the transition only", async () => {
  const src = stub({ [`8453|${A}|usdc`]: "5" });
  const cold = await runTask(input, src, "x");
  assert.equal(cold.alerts.length, 1);
  const warm = await runTask({ ...input, checkpoint: cold.checkpoint }, src, "x");
  assert.equal(warm.alerts.length, 0);
  assert.deepEqual(warm.checkpoint, cold.checkpoint);
});

test("an unread balance is unknown, never zero, and its threshold goes unevaluated", async () => {
  const out = await runTask(input, stub({}), "x");
  assert.equal(out.balances.length, 0);
  assert.equal(out.total_usd, null, "nothing read is not a total of zero");
  assert.deepEqual(out.unknowns.map((u) => u.kind), ["balance_unavailable", "threshold_unevaluated"]);
  assert.equal(out.alerts.length, 0);
});

test("generated_at falls back to the run clock", async () => {
  const { now: _now, ...rest } = input;
  const out = await runTask(rest, stub({}), "2026-09-26T00:00:00.000Z");
  assert.equal(out.generated_at, "2026-09-26T00:00:00.000Z");
});
