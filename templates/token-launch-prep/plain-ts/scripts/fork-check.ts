// The nightly fork step. Against an anvil fork of Base at the PINNED block:
//   0. fork sanity (plain viem reads, no kit): chain id, block, contract code
//      at the factory, locker, hook and MEV module, and the factory not marked
//      deprecated;
//   1. config.json through the template's own path (build -> decode ->
//      tx.simulate through the kit): the simulation passes, the factory returns
//      the expected token address, and the decoded split is the creator's
//      10000 bps;
//   2. a deploy naming a hook the factory has not enabled: the simulation
//      reports ok false with the factory's revert, never ok true;
//   3. both recorded scenarios pass on the fork as they do from the fixtures.
// This template holds no key and has no signer: nothing is signed or sent, and
// the fork's state is left as it was found (eth_call and eth_estimateGas only).
//
//   ANVIL_RPC_URL=http://127.0.0.1:8547 npm run fork-check

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, type Address } from "viem";
import { base } from "viem/chains";
import { CLANKER_V4, encodeDeploy, unsignedDeployTx } from "../src/clanker.js";
import { parseLaunchInput } from "../src/config.js";
import { prepareLaunch, simulateDeploy } from "../src/launch.js";
import { loadPolicy } from "../src/policy.js";
import { creatorRewards } from "../src/rewards.js";
import { buildRuntime, PINNED_BLOCK, type Runtime } from "../src/runtime.js";
import { EXPECTED } from "./fork-expected.js";

type Step = { id: string; ok: boolean; detail: string };
const steps: Step[] = [];

async function step(id: string, fn: () => Promise<string>) {
  try {
    const detail = await fn();
    steps.push({ id, ok: true, detail });
    console.log(`ok   ${id} — ${detail}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message.split("\n")[0] : String(e);
    steps.push({ id, ok: false, detail });
    console.log(`FAIL ${id} — ${detail}`);
  }
}

function eq(label: string, got: unknown, want: unknown) {
  if (String(got) !== String(want)) throw new Error(`${label}: expected ${String(want)}, got ${String(got)}`);
}

const DEPRECATED_ABI = [{ type: "function", name: "deprecated", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] }] as const;

async function main() {
  process.env.ANVIL_RPC_URL ??= "http://127.0.0.1:8547";
  const root = new URL("..", import.meta.url).pathname;
  const policy = loadPolicy(join(root, "policy.json"));
  const schema = JSON.parse(readFileSync(join(root, "schemas/input.json"), "utf8"));
  const c = CLANKER_V4.base;
  let rt: Runtime | null = null;

  await step("fork.sanity", async () => {
    const pc = createPublicClient({ chain: base, transport: http(process.env.ANVIL_RPC_URL) });
    eq("chain id", await pc.getChainId(), 8453);
    eq("block", await pc.getBlockNumber(), PINNED_BLOCK);
    for (const [name, a] of [["factory", c.factory], ["locker", c.locker], ["static fee hook", c.static_fee_hook], ["mev module", c.mev_module], ["fee locker", c.fee_locker]] as const) {
      const code = await pc.getCode({ address: a });
      if (!code || code === "0x") throw new Error(`no contract code at the ${name} ${a}`);
    }
    eq("factory deprecated()", await pc.readContract({ address: c.factory, abi: DEPRECATED_ABI, functionName: "deprecated" }), false);
    return `block ${PINNED_BLOCK}: code at the factory, locker, hook, MEV module and fee locker; the factory is not deprecated`;
  });

  await step("kit.simulate_config", async () => {
    rt = await buildRuntime({ mode: "fork", policy, fixturesDir: join(root, "fixtures"), env: process.env });
    const input = parseLaunchInput(JSON.parse(readFileSync(join(root, "config.json"), "utf8")), schema, "config.json");
    const r = await prepareLaunch(input, rt);
    eq("simulation ok", r.simulation.ok, true);
    eq("simulated block", r.simulation.block, PINNED_BLOCK);
    eq("predicted token address", r.simulation.predicted_token_address, EXPECTED.config_token_address);
    eq("signed", r.signed, false);
    eq("broadcast", r.broadcast, false);
    eq("reward recipients", JSON.stringify(r.summary.rewards.recipients.map((x) => [x.recipient, x.admin, x.bps])), JSON.stringify([[input.creator, input.creator, 10000]]));
    eq("value", r.unsigned_tx.value, "0");
    if (!r.simulation.gas_estimate || BigInt(r.simulation.gas_estimate) <= 0n) throw new Error("no gas estimate");
    return `deployToken simulates at block ${r.simulation.block} with gas ${r.simulation.gas_estimate}; token ${r.simulation.predicted_token_address}; creator holds 10000 bps`;
  });

  await step("kit.simulate_revert", async () => {
    if (!rt) throw new Error("no runtime (kit.simulate_config failed)");
    const creator = "0x1111111111111111111111111111111111111111" as Address;
    const { config, tx } = unsignedDeployTx({
      chain: "base", name: "Revert Probe", symbol: "RVRT", image: "", description: null, interface_name: "fork-check", token_admin: creator,
      salt: `0x${"ab".repeat(32)}`, pool_preset: "standard", clanker_fee_bps: 100, paired_fee_bps: 100, rewards: creatorRewards(creator),
    });
    // A hook the factory has never enabled: the WETH contract address.
    const bad = { ...tx, data: encodeDeploy({ ...config, poolConfig: { ...config.poolConfig, hook: c.weth } }) };
    const s = await simulateDeploy(rt.kit, rt.client, bad, creator);
    eq("simulation ok", s.ok, false);
    if (!s.error || !/revert/i.test(s.error)) throw new Error(`expected a revert, got ${s.error}`);
    return `a deploy with an unenabled hook reports ok false: ${s.error.slice(0, 80)}${s.revert_name ? ` (${s.revert_name})` : ""}`;
  });

  await step("scenarios.fork", async () => {
    if (!rt) throw new Error("no runtime (kit.simulate_config failed)");
    const dir = join(root, "fixtures/scenarios");
    const names = readdirSync(dir).filter((f) => f.endsWith(".input.json")).sort();
    for (const f of names) {
      const doc = JSON.parse(readFileSync(join(dir, f), "utf8")) as { input: unknown };
      const r = await prepareLaunch(parseLaunchInput(doc.input, schema, f), rt);
      eq(`${f} simulation ok`, r.simulation.ok, true);
      eq(`${f} predicted token`, r.simulation.predicted_token_address, EXPECTED.scenario_token_addresses[f]);
    }
    return `${names.length} scenario(s) simulate on the fork with the recorded token addresses`;
  });

  const failed = steps.filter((s) => !s.ok);
  console.log(`\nfork-check: ${steps.length - failed.length}/${steps.length} passed on the Base fork at block ${PINNED_BLOCK}. Nothing was signed or sent.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(`fork-check stopped: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
