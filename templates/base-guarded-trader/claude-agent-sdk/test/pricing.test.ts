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

// The caps come from policy.json, not from the shipped 25 / 100: a repo generated from
// a goal ("max $50 per trade") holds the user's caps. Amounts are picked from them.
const TRADE_CAP = policy.max_usd_per_trade!;
const DAY_CAP = policy.max_usd_per_day!;
const usdcUnits = (usd: number) => Math.round(usd * 1e6).toString();
/** 10 USDC at the shipped caps; half the tighter cap when the user's caps are lower. */
const UNDER = Math.min(10, Math.min(TRADE_CAP, DAY_CAP) / 2);
/** 40x the trade cap (1000 USDC at the shipped 25), a whole number of USDC. */
const OVER = Math.ceil(TRADE_CAP) * 40;

test("the priced pre-flight passes a small USDC amount and refuses 40x the cap by max_usd_per_trade", () => {
  const ev = pricedPreflight(() => ({ eth_usd: 2000 }), new SpendLedger(() => 0));
  assert.deepEqual(ev(policy, facts(usdcUnits(UNDER))).refusals, []);
  const r = ev(policy, facts(usdcUnits(OVER))).refusals.find((x) => x.rule === "max_usd_per_trade");
  assert.ok(r);
  assert.equal(r.limit, String(TRADE_CAP));
  assert.equal(r.observed, String(OVER));
});

test("a venue's own USD value is kept, and the day's spend counts", () => {
  const ledger = new SpendLedger(() => 0);
  const ev = pricedPreflight(() => ({ eth_usd: null }), ledger);
  // The venue says the trade is worth more than the trade cap: that cap refuses it.
  assert.ok(ev(policy, facts(usdcUnits(UNDER), TRADE_CAP + 5)).refusals.some((x) => x.rule === "max_usd_per_trade"));
  // Spend already at the day cap: any further trade goes over max_usd_per_day.
  ledger.add(DAY_CAP);
  assert.ok(ev(policy, facts(usdcUnits(UNDER))).refusals.some((x) => x.rule === "max_usd_per_day"));
});
