// The nightly fork step. Against an anvil fork of Base at the PINNED block:
//   0. fork sanity (plain viem, no kit): chain id, block, and the exact native
//      and USDC balances of two public addresses at the pinned block;
//   1. the same reads through the kit's chain.read, asserted exactly;
//   2. one monitor pass over config.json on the fork: exact balances, the
//      threshold alert fires once, and a resumed pass fires nothing.
// This template holds no key: nothing can be signed or sent.
//
//   ANVIL_RPC_URL=http://127.0.0.1:8547 npm run fork-check

import { readFileSync } from "node:fs";
import { createPublicClient, erc20Abi, http } from "viem";
import { base } from "viem/chains";
import { loadPolicy } from "../src/policy.js";
import { buildRuntime, type Runtime } from "../src/runtime.js";
import { kitSource } from "../src/sources.js";
import { ACTIONS, type ChainReadOutput } from "../src/kit-io.js";
import { runTask, type MonitorInput } from "../src/task.js";
import { EXPECTED, PINNED_BLOCK } from "./fork-expected.js";

type Step = { id: string; ok: boolean; detail: string };
const steps: Step[] = [];

async function step(id: string, fn: () => Promise<string>) {
  try {
    const detail = await fn();
    steps.push({ id, ok: true, detail });
    console.log(`ok   ${id} — ${detail}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    steps.push({ id, ok: false, detail });
    console.log(`FAIL ${id} — ${detail}`);
  }
}

function eq(label: string, got: unknown, want: unknown) {
  if (String(got) !== String(want)) throw new Error(`${label}: expected ${String(want)}, got ${String(got)}`);
}

async function main() {
  process.env.ANVIL_RPC_URL ??= "http://127.0.0.1:8547";
  const policy = loadPolicy(new URL("../policy.json", import.meta.url).pathname);
  const config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8")) as MonitorInput;
  let rt: Runtime | null = null;

  await step("fork.sanity", async () => {
    const c = createPublicClient({ chain: base, transport: http(process.env.ANVIL_RPC_URL) });
    eq("chain id", await c.getChainId(), EXPECTED.chain_id);
    eq("block", await c.getBlockNumber(), PINNED_BLOCK);
    for (const [name, h] of Object.entries(EXPECTED.holders)) {
      eq(`${name} ETH`, await c.getBalance({ address: h.address, blockNumber: PINNED_BLOCK }), h.eth_wei);
      eq(`${name} USDC`, await c.readContract({ address: EXPECTED.usdc, abi: erc20Abi, functionName: "balanceOf", args: [h.address], blockNumber: PINNED_BLOCK }), h.usdc_base_units);
    }
    return `block ${PINNED_BLOCK}: both holders' ETH and USDC balances match`;
  });

  await step("kit.chain_read", async () => {
    rt = await buildRuntime({ mode: "fork", policy, fixturesDir: new URL("../fixtures", import.meta.url).pathname, env: process.env });
    const h = EXPECTED.holders.burn;
    const nat = await rt.kit.read<ChainReadOutput<string>>(ACTIONS.chainRead, { kind: "native_balance", chain: "base", address: h.address });
    eq("kit block_number", nat.block_number, PINNED_BLOCK);
    eq("kit native_balance", nat.result, h.eth_wei);
    const erc = await rt.kit.read<ChainReadOutput<string>>(ACTIONS.chainRead, { kind: "erc20_balance", chain: "base", token: EXPECTED.usdc, owner: h.address });
    eq("kit erc20_balance", erc.result, h.usdc_base_units);
    return `chain.read at block ${nat.block_number} matches the pinned values`;
  });

  await step("monitor.pass", async () => {
    if (!rt) throw new Error("no runtime");
    const source = kitSource("fork", rt.kit, rt.chains);
    const cold = await runTask(config, source, "2026-09-26T00:00:00.000Z");
    eq("read_at", JSON.stringify(cold.read_at), JSON.stringify([{ chain: "base", block_number: PINNED_BLOCK.toString() }]));
    const burnUsdc = cold.balances.find((b) => b.address_label === "burn" && b.asset === "USDC");
    eq("burn USDC", burnUsdc?.base_units, EXPECTED.holders.burn.usdc_base_units);
    eq("alerts on a cold start", cold.alerts.length, 1);
    eq("total_usd with ETH unpriced", cold.total_usd, null);
    const resumed = await runTask({ ...config, checkpoint: cold.checkpoint }, source, "2026-09-26T01:00:00.000Z");
    eq("alerts after resume", resumed.alerts.length, 0);
    return `${cold.balances.length} balance(s) read; the floor alert fired once and stayed quiet on resume`;
  });

  const failed = steps.filter((s) => !s.ok);
  console.log(`\nfork-check: ${steps.length - failed.length}/${steps.length} passed at block ${PINNED_BLOCK}. This template holds no key; nothing was signed or sent.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
