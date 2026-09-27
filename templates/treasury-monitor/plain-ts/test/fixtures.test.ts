// Every recorded scenario, through the kit's chain.read over fixtures/rpc.json.
// No network: an unrecorded RPC call throws.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateConfig } from "../src/config.js";
import { loadPolicy } from "../src/policy.js";
import { buildRuntime } from "../src/runtime.js";
import { kitSource } from "../src/sources.js";
import { runTask, type MonitorInput, type MonitorOutput } from "../src/task.js";

const inputSchema = JSON.parse(readFileSync("schemas/input.json", "utf8"));
const outputSchema = JSON.parse(readFileSync("schemas/output.json", "utf8"));
const scenarios = readdirSync("fixtures/scenarios").filter((f) => f.endsWith(".input.json")).sort();

async function run(input: MonitorInput): Promise<MonitorOutput> {
  const rt = await buildRuntime({ mode: "fixture", policy: loadPolicy("policy.json"), fixturesDir: "fixtures", env: {} });
  return runTask(input, kitSource(rt.mode, rt.kit, rt.chains), new Date(rt.clock()).toISOString());
}
function load(name: string): MonitorInput {
  return (JSON.parse(readFileSync(join("fixtures/scenarios", `${name}.input.json`), "utf8")) as { input: MonitorInput }).input;
}

test("every scenario and config.json are valid input and produce valid output", async () => {
  const inputs = [JSON.parse(readFileSync("config.json", "utf8")), ...scenarios.map((f) => JSON.parse(readFileSync(join("fixtures/scenarios", f), "utf8")).input)];
  for (const i of inputs) {
    assert.deepEqual(validateConfig(i, inputSchema), []);
    const out = await run(i);
    assert.deepEqual(validateConfig(out, outputSchema, "output"), []);
    assert.equal(out.source_kind, "fixture");
  }
});

test("mixed holdings: exact balances at the pinned block, ETH unpriced, no partial total", async () => {
  const out = await run(load("mixed-holdings"));
  assert.deepEqual(out.read_at, [{ chain: "base", block_number: "51800000" }]);
  assert.deepEqual(out.balances.map((b) => [b.address_label, b.asset, b.base_units, b.native, b.value_usd]), [
    ["weth-contract", "ETH", "263597196816461051072736", "263597.196816461051072736", null],
    ["weth-contract", "USDC", "167551481", "167.551481", "167.551481"],
    ["burn", "USDC", "25896806146", "25896.806146", "25896.806146"],
  ]);
  assert.equal(out.total_usd, null);
  assert.deepEqual(out.unknowns.map((u) => u.kind), ["price_unavailable"]);
});

test("all priced: the total is the exact sum", async () => {
  assert.equal((await run(load("usdc-only-priced"))).total_usd, "26064.357627");
});

test("threshold: fires cold, stays quiet on resume", async () => {
  const cold = await run(load("threshold-crossing-cold"));
  assert.equal(cold.alerts.length, 1);
  assert.equal(cold.alerts[0].observed_base_units, "25896806146");
  const resume = await run(load("threshold-resume"));
  assert.equal(resume.alerts.length, 0);
  assert.deepEqual(resume.checkpoint, cold.checkpoint);
});

test("a chain with no RPC in this run is unknown, never zero", async () => {
  const out = await run(load("balance-unavailable"));
  assert.equal(out.balances.length, 0);
  assert.equal(out.total_usd, null);
  assert.deepEqual(out.unknowns.map((u) => u.kind), ["balance_unavailable", "threshold_unevaluated"]);
  assert.deepEqual(out.read_at, []);
});

test("an unrecorded read is reported, never answered from the network", async () => {
  const out = await run({ assets: [{ id: "eth", symbol: "ETH", decimals: 18, token: null }], addresses: [{ label: "x", address: "0x" + "3".repeat(40), chain: 8453, assets: ["eth"] }] });
  assert.equal(out.balances.length, 0);
  assert.match(out.unknowns[0].detail, /no recorded RPC answer/);
});
