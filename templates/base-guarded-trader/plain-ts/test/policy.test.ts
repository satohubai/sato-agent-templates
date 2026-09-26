import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePolicyFile } from "@satohub/kit";
import { loadPolicy } from "../src/policy.js";
import { TOKENS } from "../src/tokens.js";

const raw = JSON.parse(readFileSync("policy.json", "utf8"));

test("policy.json is a valid sato.policy/v1 file", () => {
  const p = parsePolicyFile(raw);
  assert.ok(p.ok, p.ok ? "" : p.error);
});

test("policy.json holds the template's defaults", () => {
  const p = loadPolicy("policy.json");
  assert.equal(p.network, "fork");
  assert.deepEqual(p.allow_chains, ["base", "base-sepolia"]);
  assert.equal(p.max_usd_per_trade, 25);
  assert.equal(p.max_usd_per_day, 100);
  assert.equal(p.max_slippage_bps, 100);
  assert.equal(p.unknown_verdict, "refuse");
  assert.equal(p.intent_ttl_s, 300);
  assert.equal(p.require_simulation, true);
});

test("allow_tokens names USDC and WETH on Base, chain-qualified", () => {
  const p = loadPolicy("policy.json");
  for (const t of [TOKENS.base.USDC.address, TOKENS.base.WETH.address]) assert.ok(p.allow_tokens.includes(`base:${t}`), `base:${t}`);
  for (const t of p.allow_tokens) assert.match(t, /^(base|base-sepolia):0x[0-9a-fA-F]{40}$/);
});

test("a mainnet policy is refused by the template", () => {
  assert.throws(() => {
    const p = parsePolicyFile({ ...raw, network: "mainnet" });
    if (p.ok && p.policy.network === "mainnet") throw new Error("this template does not run on mainnet");
  }, /mainnet/);
});
