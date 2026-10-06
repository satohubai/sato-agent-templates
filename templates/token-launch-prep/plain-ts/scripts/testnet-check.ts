// The weekly Base Sepolia step. Keyless: against a public Base Sepolia RPC
// (BASE_SEPOLIA_RPC_URL):
//   0. testnet sanity (plain viem reads, no kit): chain id 84532, contract code
//      at the Clanker v4 factory, locker, static-fee hook and MEV module that
//      clanker-sdk 4.2.19 names for Base Sepolia;
//   1. config.json, moved to base-sepolia with a fresh random salt (so no
//      earlier deploy can collide), through the template's own path: build ->
//      decode -> tx.simulate through the kit. The simulation must pass and the
//      factory must return a token address. Gas and the address are printed,
//      never asserted: they move on a live chain.
// Nothing is signed or sent: the kit has no signer, and tx.simulate runs only
// eth_call and eth_estimateGas.
//
//   BASE_SEPOLIA_RPC_URL=https://sepolia.base.org npm run testnet-check

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, toHex, type PublicClient } from "viem";
import { baseSepolia } from "viem/chains";
import { CLANKER_V4 } from "../src/clanker.js";
import { parseLaunchInput } from "../src/config.js";
import { prepareLaunch } from "../src/launch.js";
import { loadPolicy } from "../src/policy.js";
import { kitFor, uaHttp } from "../src/runtime.js";

type Step = { id: string; ok: boolean; detail: string };
const steps: Step[] = [];
async function step(id: string, fn: () => Promise<string>) {
  try { const d = await fn(); steps.push({ id, ok: true, detail: d }); console.log(`ok   ${id} — ${d}`); }
  catch (e) { const d = e instanceof Error ? e.message.split("\n")[0] : String(e); steps.push({ id, ok: false, detail: d }); console.log(`FAIL ${id} — ${d}`); }
}
function eq(label: string, got: unknown, want: unknown) {
  if (String(got) !== String(want)) throw new Error(`${label}: expected ${String(want)}, got ${String(got)}`);
}

async function main() {
  const url = process.env.BASE_SEPOLIA_RPC_URL;
  if (!url) throw new Error("testnet-check needs BASE_SEPOLIA_RPC_URL (a public Base Sepolia RPC, e.g. https://sepolia.base.org). It needs no key.");
  const root = new URL("..", import.meta.url).pathname;
  const policy = { ...loadPolicy(join(root, "policy.json")), network: "testnet" as const };
  const schema = JSON.parse(readFileSync(join(root, "schemas/input.json"), "utf8"));
  const client = createPublicClient({ chain: baseSepolia, transport: uaHttp(url) }) as PublicClient;
  const c = CLANKER_V4["base-sepolia"];

  await step("testnet.sanity", async () => {
    eq("chain id", await client.getChainId(), 84532);
    for (const [name, a] of [["factory", c.factory], ["locker", c.locker], ["static fee hook", c.static_fee_hook], ["mev module", c.mev_module]] as const) {
      const code = await client.getCode({ address: a });
      if (!code || code === "0x") throw new Error(`no contract code at the ${name} ${a}`);
    }
    return `chain 84532: code at the factory ${c.factory}, locker, static-fee hook and MEV module`;
  });

  await step("kit.simulate_config", async () => {
    const clock = () => Date.now();
    const rt = { mode: "rpc" as const, kit: kitFor(policy, client, clock), client, chain: "base-sepolia" as const, clock };
    const raw = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
    const input = parseLaunchInput({ ...raw, chain: "base-sepolia", salt: toHex(randomBytes(32)) }, schema, "config.json (base-sepolia)");
    const r = await prepareLaunch(input, rt);
    if (!r.simulation.ok) throw new Error(`simulation did not pass at block ${r.simulation.block}: ${r.simulation.error}${r.simulation.revert_name ? ` (${r.simulation.revert_name})` : ""}`);
    if (!r.simulation.predicted_token_address) throw new Error("the factory returned no token address");
    eq("chain id in the unsigned tx", r.unsigned_tx.chain_id, 84532);
    eq("signed", r.signed, false);
    eq("broadcast", r.broadcast, false);
    eq("reward total", r.summary.rewards.total_bps, 10000);
    return `deployToken simulates at block ${r.simulation.block} (gas ${r.simulation.gas_estimate}); the factory returned ${r.simulation.predicted_token_address}`;
  });

  const failed = steps.filter((s) => !s.ok);
  console.log(`\ntestnet-check: ${steps.length - failed.length}/${steps.length} passed on Base Sepolia. Nothing was signed or sent.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(`testnet-check stopped: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
