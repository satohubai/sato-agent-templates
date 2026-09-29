// The weekly Base Sepolia step. Keyless: against the public Base Sepolia RPC
// (BASE_SEPOLIA_RPC_URL), through the template's own rpc mode:
//   0. testnet sanity (plain viem, no kit): chain id 84532, contract code at
//      Circle's testnet USDC and the WETH predeploy, and their decimals;
//   1. native_balance and erc20_balance through the kit's chain.read: the
//      answer names base-sepolia and a block, and each balance is a decimal
//      string (balances move on a live chain, so their SHAPE is checked, never
//      their value);
//   2. one monitor pass over a Base Sepolia watch list: every balance read,
//      nothing reported unavailable, a threshold set above USDC's whole
//      supply fires exactly once, and a resumed pass fires nothing.
// This template holds no key: nothing can be signed or sent.
//
//   BASE_SEPOLIA_RPC_URL=https://sepolia.base.org npm run testnet-check

import { createPublicClient, erc20Abi, http } from "viem";
import { baseSepolia } from "viem/chains";
import { loadPolicy } from "../src/policy.js";
import { buildRuntime, USER_AGENT, type Runtime } from "../src/runtime.js";
import { kitSource } from "../src/sources.js";
import { ACTIONS, type ChainReadOutput } from "../src/kit-io.js";
import { runTask, type MonitorInput } from "../src/task.js";

const CHAIN_ID = 84532;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const; // Circle's Base Sepolia USDC
const WETH = "0x4200000000000000000000000000000000000006" as const; // OP-stack predeploy
const BURN = "0x000000000000000000000000000000000000dEaD" as const;
const DECIMAL = /^[0-9]+$/;

/** A watch list on Base Sepolia. The threshold is above any possible balance, so it fires on every cold start. */
export const TESTNET_WATCH: MonitorInput = {
  assets: [
    { id: "eth", symbol: "ETH", decimals: 18, token: null },
    { id: "usdc", symbol: "USDC", decimals: 6, token: USDC },
  ],
  addresses: [
    { label: "weth-contract", address: WETH, chain: CHAIN_ID, assets: ["eth", "usdc"] },
    { label: "burn", address: BURN, chain: CHAIN_ID, assets: ["eth", "usdc"] },
  ],
  thresholds: [{ chain: CHAIN_ID, address: BURN, asset: "usdc", direction: "below", base_units: (10n ** 30n).toString() }],
  prices: [{ asset: "usdc", usd: "1.00", source: "config:usdc-counted-at-1.00-usd (an assumption, not a price read)" }],
} as MonitorInput;

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

async function main() {
  const url = process.env.BASE_SEPOLIA_RPC_URL;
  if (!url) throw new Error("testnet-check needs BASE_SEPOLIA_RPC_URL (a public Base Sepolia RPC, e.g. https://sepolia.base.org). It needs no key.");
  const policy = loadPolicy(new URL("../policy.json", import.meta.url).pathname);
  let rt: Runtime | null = null;

  await step("testnet.sanity", async () => {
    const c = createPublicClient({ chain: baseSepolia, transport: http(url, { timeout: 30_000, fetchOptions: { headers: { "user-agent": USER_AGENT } } }) });
    eq("chain id", await c.getChainId(), CHAIN_ID);
    for (const [name, address, decimals] of [["USDC", USDC, 6], ["WETH", WETH, 18]] as const) {
      const code = await c.getCode({ address });
      if (!code || code === "0x") throw new Error(`no contract code at ${name} ${address}`);
      eq(`${name} decimals`, await c.readContract({ address, abi: erc20Abi, functionName: "decimals" }), decimals);
    }
    return `chain ${CHAIN_ID}; USDC and WETH have code and the expected decimals`;
  });

  await step("kit.chain_read", async () => {
    rt = await buildRuntime({ mode: "rpc", policy, fixturesDir: new URL("../fixtures", import.meta.url).pathname, env: process.env, rpcUrl: url });
    eq("runtime chains", rt.chains.join(","), "base-sepolia");
    const nat = await rt.kit.read<ChainReadOutput<string>>(ACTIONS.chainRead, { kind: "native_balance", chain: "base-sepolia", address: BURN });
    eq("kit chain", nat.chain, "base-sepolia");
    if (!/^[1-9][0-9]*$/.test(nat.block_number)) throw new Error(`kit block_number is not a block: ${nat.block_number}`);
    if (!DECIMAL.test(String(nat.result))) throw new Error(`native_balance is not a decimal string: ${nat.result}`);
    const erc = await rt.kit.read<ChainReadOutput<string>>(ACTIONS.chainRead, { kind: "erc20_balance", chain: "base-sepolia", token: USDC, owner: BURN });
    if (!DECIMAL.test(String(erc.result))) throw new Error(`erc20_balance is not a decimal string: ${erc.result}`);
    return `chain.read at block ${nat.block_number}: native and USDC balances answered as decimal strings`;
  });

  await step("monitor.pass", async () => {
    if (!rt) throw new Error("no runtime");
    const source = kitSource("rpc", rt.kit, rt.chains);
    const cold = await runTask(TESTNET_WATCH, source, new Date().toISOString());
    eq("balances read", cold.balances.length, 4);
    for (const b of cold.balances) if (!DECIMAL.test(String(b.base_units))) throw new Error(`${b.address_label} ${b.asset}: not a decimal string (${b.base_units})`);
    const unavailable = cold.unknowns.filter((u) => u.kind === "balance_unavailable");
    if (unavailable.length) throw new Error(`balance unavailable: ${unavailable.map((u) => u.detail).join("; ")}`);
    if (!cold.read_at.every((r) => r.chain === "base-sepolia")) throw new Error(`read_at names another chain: ${JSON.stringify(cold.read_at)}`);
    eq("alerts on a cold start", cold.alerts.length, 1);
    const resumed = await runTask({ ...TESTNET_WATCH, checkpoint: cold.checkpoint }, source, new Date().toISOString());
    eq("alerts after resume", resumed.alerts.length, 0);
    return `${cold.balances.length} balances read on Base Sepolia; the threshold alert fired once and stayed quiet on resume`;
  });

  const failed = steps.filter((s) => !s.ok);
  console.log(`\ntestnet-check: ${steps.length - failed.length}/${steps.length} passed on Base Sepolia. This template holds no key; nothing was signed or sent.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
