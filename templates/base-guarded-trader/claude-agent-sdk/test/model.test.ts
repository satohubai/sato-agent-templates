import { test } from "node:test";
import assert from "node:assert/strict";
import { MockModel } from "../src/model.js";
import { parseConfig } from "../src/config.js";

const cfg = parseConfig({ venue: "sato", amount_usdc: "10", over_cap_amount_usdc: "1000", slippage_bps: 50 });
const market = { block: "51800000", gas_price_gwei: "1.005", eth_usd: 2695.0463635 };

test("MockModel is deterministic", () => {
  const m = new MockModel();
  assert.deepEqual(m.decide(market, cfg), m.decide(market, cfg));
});

test("MockModel proposes the configured trade and one over-cap demo intent", () => {
  const ideas = new MockModel().decide(market, cfg);
  assert.equal(ideas.length, 2);
  assert.deepEqual(ideas.map((i) => [i.token_in, i.token_out, i.amount, i.demo_refusal]), [
    ["USDC", "WETH", "10", false],
    ["USDC", "WETH", "1000", true],
  ]);
});

test("MockModel proposes nothing when the price is unknown", () => {
  assert.deepEqual(new MockModel().decide({ ...market, eth_usd: null }, cfg), []);
});
