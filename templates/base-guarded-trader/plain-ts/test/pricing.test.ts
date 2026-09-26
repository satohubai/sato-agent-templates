import { test } from "node:test";
import assert from "node:assert/strict";
import { pricedPreflight, SpendLedger, usdValue } from "../src/pricing.js";
import { loadPolicy } from "../src/policy.js";
import { TOKENS } from "../src/tokens.js";

const policy = loadPolicy("policy.json");
const facts = (amount: string, usd_value: number | null = null) => ({
  action: "swap.prepare",
  chain: "base" as const,
  network: "fork" as const,
  token: TOKENS.base.USDC.address,
  token_amount_base_units: amount,
  usd_value,
  usd_spent_today: null,
  slippage_bps: 50,
  simulation: { ok: true, method: "eth_call+eth_estimateGas", block: "1", gas_estimate: "1", error: null, as_of: "2026-09-26T00:00:00Z" },
  ttl_s: 300,
});

test("usdValue: USDC at 1.00, WETH at the feed, anything else unknown", () => {
  assert.equal(usdValue("base", TOKENS.base.USDC.address, "10000000", { eth_usd: null }), 10);
  assert.equal(usdValue("base", TOKENS.base.WETH.address, "500000000000000000", { eth_usd: 2000 }), 1000);
  assert.equal(usdValue("base", TOKENS.base.WETH.address, "1", { eth_usd: null }), null);
  assert.equal(usdValue("base", "0x0000000000000000000000000000000000000001", "1", { eth_usd: 1 }), null);
});

test("the priced pre-flight passes 10 USDC and refuses 1000 USDC by max_usd_per_trade", () => {
  const ev = pricedPreflight(() => ({ eth_usd: 2000 }), new SpendLedger(() => 0));
  assert.deepEqual(ev(policy, facts("10000000")).refusals, []);
  const r = ev(policy, facts("1000000000")).refusals.find((x) => x.rule === "max_usd_per_trade");
  assert.ok(r);
  assert.equal(r.limit, "25");
  assert.equal(r.observed, "1000");
});

test("a venue's own USD value is kept, and the day's spend counts", () => {
  const ledger = new SpendLedger(() => 0);
  const ev = pricedPreflight(() => ({ eth_usd: null }), ledger);
  assert.equal(ev(policy, facts("10000000", 30)).refusals[0]?.rule, "max_usd_per_trade");
  ledger.add(95);
  assert.ok(ev(policy, facts("10000000")).refusals.some((x) => x.rule === "max_usd_per_day"));
});
