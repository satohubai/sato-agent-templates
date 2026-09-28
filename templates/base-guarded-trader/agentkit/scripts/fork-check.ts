// The nightly fork step. Against an anvil fork of Base at the PINNED block,
// with no live venue call:
//   0. fork sanity (plain viem, no kit): chain id, block, and the exact
//      Chainlink ETH/USD round and USDC totalSupply at the pinned block;
//   1. the same two reads through the kit's chain.read, asserted exactly;
//   2. tx.simulate of an unsigned USDC approve from the funded throwaway key;
//   3. swap.prepare over the RECORDED quotes: the in-cap intent carries no
//      network/policy refusal, the over-cap intent is refused by
//      max_usd_per_trade with limit 25;
//   4. the same prepare through the AgentKit swap_prepare action, and the
//      wallet provider AgentKit holds is the kit's signer;
//   5. execute through AgentKit is refused (no approve callback on a fork).
// Nothing is ever broadcast: the signer is wrapped to throw on send, and
// execute is never called.
//
//   ANVIL_RPC_URL=http://127.0.0.1:8547 npm run fork-check

import { readFileSync } from "node:fs";
import { encodeFunctionData, parseUnits } from "viem";
import type { PreparedIntent } from "@satohub/kit";
import { buildRuntime, FORK_FUNDING_WEI, type Runtime } from "../src/runtime.js";
import { loadPolicy } from "../src/policy.js";
import { ACTIONS, fragment, type ChainReadInput, type ChainReadOutput, type SwapInput } from "../src/kit-io.js";
import { ERC20_ABI, FEED_ABI, TOKENS } from "../src/tokens.js";
import { EXPECTED, PINNED_BLOCK } from "./fork-expected.js";
import { buildAgentKit, TOOLS, type Envelope } from "../src/agentkit.js";

// A well-known spender for the approve (Uniswap's Permit2, same address on every chain).
const SPENDER = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;
/** Rules that depend on the chain's state rather than the policy file; excluded from step 3's comparison. */
const STATE_RULES = new Set(["simulation_failed", "simulation_required", "unknown_price"]);

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
  const cfg = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8")) as { amount_usdc: string; over_cap_amount_usdc: string; slippage_bps: number };
  let rt: Runtime | null = null;

  await step("fork.sanity", async () => {
    const { createPublicClient, http } = await import("viem");
    const { base } = await import("viem/chains");
    const c = createPublicClient({ chain: base, transport: http(process.env.ANVIL_RPC_URL) });
    eq("chain id", await c.getChainId(), EXPECTED.chain_id);
    eq("block", await c.getBlockNumber(), PINNED_BLOCK);
    const b = await c.getBlock({ blockNumber: PINNED_BLOCK });
    eq("block timestamp", b.timestamp, EXPECTED.block_timestamp);
    const round = await c.readContract({ address: EXPECTED.eth_usd_feed.address, abi: FEED_ABI, functionName: "latestRoundData", blockNumber: PINNED_BLOCK });
    eq("roundId", round[0], EXPECTED.eth_usd_feed.round_id);
    eq("answer", round[1], EXPECTED.eth_usd_feed.answer);
    eq("updatedAt", round[3], EXPECTED.eth_usd_feed.updated_at);
    const supply = await c.readContract({ address: EXPECTED.usdc.address, abi: ERC20_ABI, functionName: "totalSupply", blockNumber: PINNED_BLOCK });
    eq("USDC totalSupply", supply, EXPECTED.usdc.total_supply);
    return `block ${PINNED_BLOCK}, ETH/USD answer ${round[1]}, USDC supply ${supply}`;
  });

  await step("kit.runtime", async () => {
    rt = await buildRuntime({ mode: "fork", policy, fixturesDir: new URL("../fixtures", import.meta.url).pathname, env: process.env, recordedQuotes: true });
    const bal = await rt.client.getBalance({ address: await rt.signer!.address("base") });
    eq("throwaway key balance", bal, FORK_FUNDING_WEI);
    return `throwaway ${rt.signer!.kind} key ${await rt.signer!.address("base")}, funded ${bal} wei by anvil_setBalance`;
  });

  await step("kit.chain_read", async () => {
    if (!rt) throw new Error("no runtime");
    // chain.read answers at the RPC's latest block; the fork sits at the pinned block (nothing is mined).
    const round = await rt.kit.read<ChainReadOutput<readonly string[]>>(ACTIONS.chainRead, { kind: "contract_read", chain: "base", contract: EXPECTED.eth_usd_feed.address, abi: fragment(FEED_ABI, "latestRoundData") } satisfies ChainReadInput);
    eq("kit block_number", round.block_number, PINNED_BLOCK);
    eq("kit latestRoundData.answer", round.result[1], EXPECTED.eth_usd_feed.answer);
    eq("kit latestRoundData.updatedAt", round.result[3], EXPECTED.eth_usd_feed.updated_at);
    const supply = await rt.kit.read<ChainReadOutput<string>>(ACTIONS.chainRead, { kind: "contract_read", chain: "base", contract: EXPECTED.usdc.address, abi: fragment(ERC20_ABI, "totalSupply") } satisfies ChainReadInput);
    eq("kit USDC totalSupply", supply.result, EXPECTED.usdc.total_supply);
    rt.usd.eth_usd = Number(round.result[1]) / 1e8;
    return `chain.read at block ${round.block_number} matches the pinned values`;
  });

  await step("kit.tx_simulate", async () => {
    if (!rt) throw new Error("no runtime");
    const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [SPENDER, parseUnits("25", 6)] });
    const sim = await rt.kit.read<{ ok: boolean; error: string | null; method: string }>(ACTIONS.txSimulate, {
      chain: "base", from: rt.taker, to: TOKENS.base.USDC.address, data, value: "0",
    });
    if (!sim.ok) throw new Error(`approve simulation failed: ${sim.error}`);
    return `unsigned USDC approve simulated ok via ${sim.method}`;
  });

  const prep = async (amount: string): Promise<PreparedIntent> => {
    if (!rt) throw new Error("no runtime");
    const input: SwapInput = {
      chain: "base",
      sell_token: TOKENS.base.USDC.address,
      buy_token: TOKENS.base.WETH.address,
      sell_amount: parseUnits(amount, 6).toString(),
      slippage_bps: cfg.slippage_bps,
      venue: "sato",
      taker: rt.taker,
    };
    return rt.kit.prepare(ACTIONS.swapPrepare, input);
  };

  await step("kit.swap_prepare.in_cap", async () => {
    const p = await prep(cfg.amount_usdc);
    const policyRefusals = p.policy.refusals.filter((r) => !STATE_RULES.has(r.rule));
    if (policyRefusals.length) throw new Error(`expected no network/policy refusal, got ${policyRefusals.map((r) => r.rule).join(", ")}`);
    return `${cfg.amount_usdc} USDC: no network/policy refusal (simulation ${p.simulation ? (p.simulation.ok ? "ok" : "failed — the throwaway key holds no USDC") : "not run"})`;
  });

  await step("kit.swap_prepare.over_cap", async () => {
    const p = await prep(cfg.over_cap_amount_usdc);
    if (p.policy.ok) throw new Error("the over-cap intent passed the pre-flight");
    const r = p.policy.refusals.find((x) => x.rule === "max_usd_per_trade");
    if (!r) throw new Error(`expected a max_usd_per_trade refusal, got ${p.policy.refusals.map((x) => x.rule).join(", ") || "none"}`);
    eq("refusal limit", Number(r.limit), 25);
    if (!r.observed || r.observed === "unknown") throw new Error(`observed should be the trade's USD value, got ${r.observed}`);
    return `${cfg.over_cap_amount_usdc} USDC refused: rule=${r.rule} limit=${r.limit} observed=${r.observed}`;
  });

  await step("agentkit.wallet_provider", async () => {
    if (!rt) throw new Error("no runtime");
    eq("wallet provider network", rt.walletProvider.getNetwork().chainId, "8453");
    eq("wallet provider address = kit signer", rt.walletProvider.getAddress().toLowerCase(), (await rt.signer!.address("base")).toLowerCase());
    return `${rt.walletProvider.getName()} holds the kit's throwaway key on chain 8453`;
  });

  await step("agentkit.swap_prepare.over_cap", async () => {
    if (!rt) throw new Error("no runtime");
    const ak = await buildAgentKit({ kit: rt.kit, walletProvider: rt.walletProvider, policy, signerKind: rt.signer!.kind });
    const env = (await ak.call(TOOLS.swapPrepare, {
      chain: "base",
      sell_token: TOKENS.base.USDC.address,
      buy_token: TOKENS.base.WETH.address,
      sell_amount: parseUnits(cfg.over_cap_amount_usdc, 6).toString(),
      slippage_bps: cfg.slippage_bps,
      venue: "sato",
      taker: rt.taker,
    })) as Envelope<PreparedIntent>;
    if (env.ok) throw new Error("the over-cap intent passed the pre-flight through AgentKit");
    const r = env.error.refusals?.find((x) => x.rule === "max_usd_per_trade");
    if (env.error.code !== "policy_refused" || !r) throw new Error(`expected policy_refused with max_usd_per_trade, got ${env.error.code}: ${env.error.message}`);
    eq("refusal limit", Number(r.limit), 25);
    return `AgentKit swap_prepare refused: rule=${r.rule} limit=${r.limit} observed=${r.observed}`;
  });

  await step("agentkit.execute.refused", async () => {
    if (!rt) throw new Error("no runtime");
    const ak = await buildAgentKit({ kit: rt.kit, walletProvider: rt.walletProvider, policy, signerKind: rt.signer!.kind });
    const env = await ak.call(TOOLS.execute, { intent_id: "si_" + "A".repeat(43) });
    if (env.ok || env.error.code !== "approval_required") throw new Error(`expected approval_required, got ${JSON.stringify(env)}`);
    return "execute refused by the action provider: approval_required";
  });

  const failed = steps.filter((s) => !s.ok);
  console.log(`\nfork-check: ${steps.length - failed.length}/${steps.length} passed at block ${PINNED_BLOCK}. Nothing was broadcast.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
