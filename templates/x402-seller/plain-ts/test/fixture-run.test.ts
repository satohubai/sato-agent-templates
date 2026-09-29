import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { runScenario, type Scenario } from "../src/agent.js";
import type { SellerConfig } from "../src/config.js";
import { loadPolicy } from "../src/policy.js";
import { buildRuntime } from "../src/runtime.js";
import { buildListing } from "../src/listing.js";

const config = JSON.parse(readFileSync("config.json", "utf8")) as SellerConfig;

test("every fixture scenario answers as expected, in order, offline", async () => {
  const rt = await buildRuntime({ mode: "fixture", policy: loadPolicy("policy.json"), config, fixturesDir: "fixtures", env: {} });
  const got: Record<string, [number, string | null]> = {};
  for (const f of readdirSync("fixtures/scenarios").sort()) {
    const r = await runScenario(rt, config, basename(f, ".json"), JSON.parse(readFileSync(`fixtures/scenarios/${f}`, "utf8")) as Scenario);
    assert.ok(r.as_expected, `${r.id}: ${r.status} ${r.refused_reason}`);
    got[r.id] = [r.status, r.refused_reason];
    if (r.id === "02-paid") {
      assert.equal(r.receipt?.confirmation.status, "confirmed");
      assert.equal(r.receipt?.facilitator, "fake");
      assert.equal(r.receipt?.amount, "1000");
    }
  }
  assert.deepEqual(got, {
    "01-unpaid": [402, null],
    "02-paid": [200, null],
    "03-replay": [402, "nonce_already_used"],
    "04-over-price": [402, "amount_exceeds_price"],
    "05-wrong-asset": [402, "asset_not_accepted"],
    "06-bad-signature": [402, "invalid_signature"],
  });
});

test("the listing file is generated, marked not submitted, one entry per route", () => {
  const l = buildListing(config, config.networks.testnet, "testnet", "2026-09-28T00:00:00.000Z");
  assert.equal(l.submitted, false);
  assert.equal(l.x402Version, 2);
  assert.equal(l.resources.length, config.routes.length);
  assert.equal(l.resources[0].accepts[0].network, "eip155:84532");
  assert.equal(l.resources[0].resource.serviceName, config.service.name);
});
