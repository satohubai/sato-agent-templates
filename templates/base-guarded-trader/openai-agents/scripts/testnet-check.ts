// The weekly Base Sepolia step. Keyless: against the public Base Sepolia RPC
// (BASE_SEPOLIA_RPC_URL), with no key, no signer and no managed wallet:
//   0. testnet sanity (plain viem, no kit): chain id 84532, a moving head,
//      contract code at Circle's testnet USDC, the WETH predeploy and the
//      Chainlink ETH/USD feed, and their decimals / symbol / description;
//   1. the same reads through the kit's chain.read, asserted exactly (these
//      are constants of the contracts, not balances, so a live chain cannot
//      move them), plus a positive ETH/USD answer;
//   2. tx.simulate of an unsigned USDC approve from a fixed address that
//      nobody here holds a key for;
//   3. the pre-flight's answers under policy.json with network "testnet",
//      through the same evaluate the kit is built with: an over-cap USDC
//      intent and a 1 WETH intent valued at the live ETH/USD answer are
//      refused by max_usd_per_trade with limit 25, an in-cap intent meets no
//      USD cap, and a mainnet intent is refused by network_mainnet_not_enabled.
// Nothing is signed or broadcast: the kit here has no signer, and execute is
// never called.
//
//   BASE_SEPOLIA_RPC_URL=https://sepolia.base.org npm run testnet-check

import { createPublicClient, encodeFunctionData, erc20Abi, http, parseUnits, type PublicClient } from "viem";
import { baseSepolia } from "viem/chains";
import { randomBytes } from "node:crypto";
import { CORE_ACTIONS, createKit, memoryIntentStore, memoryReceiptLog, type PreflightFacts, type SatoPolicy } from "@satohub/kit";
import { loadPolicy } from "../src/policy.js";
import { pricedPreflight, SpendLedger, type UsdSource } from "../src/pricing.js";
import { ACTIONS, fragment, type ChainReadInput, type ChainReadOutput } from "../src/kit-io.js";
import { ERC20_ABI, ETH_USD_FEED, FEED_ABI, TOKENS } from "../src/tokens.js";
import { FIXTURE_TAKER, USER_AGENT } from "../src/runtime.js";

const CHAIN_ID = 84532;
const SPENDER = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const; // Permit2, same address on every chain
const USDC = TOKENS["base-sepolia"].USDC;
const WETH = TOKENS["base-sepolia"].WETH;
const FEED = ETH_USD_FEED["base-sepolia"];

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
  const client = createPublicClient({ chain: baseSepolia, transport: http(url, { timeout: 30_000, fetchOptions: { headers: { "user-agent": USER_AGENT } } }) }) as PublicClient;
  const policy: SatoPolicy = { ...loadPolicy(new URL("../policy.json", import.meta.url).pathname), network: "testnet" };
  const usd: UsdSource = { eth_usd: null };
  const ledger = new SpendLedger(() => Date.now());
  const evaluate = pricedPreflight(() => usd, ledger);
  const kit = createKit({
    policy,
    secret: new Uint8Array(randomBytes(32)),
    rpc: (c) => {
      if (c !== "base-sepolia") throw new Error(`testnet-check reads base-sepolia only, not ${c}`);
      return client;
    },
    evaluate,
    actions: CORE_ACTIONS.list(),
    intents: memoryIntentStore(),
    receipts: memoryReceiptLog(),
    userAgent: USER_AGENT,
  });

  await step("testnet.sanity", async () => {
    eq("chain id", await client.getChainId(), CHAIN_ID);
    const head = await client.getBlockNumber();
    if (head <= 0n) throw new Error(`head block ${head}`);
    for (const [name, address] of [["USDC", USDC.address], ["WETH", WETH.address], ["ETH/USD feed", FEED]] as const) {
      const code = await client.getCode({ address });
      if (!code || code === "0x") throw new Error(`no contract code at ${name} ${address}`);
    }
    eq("USDC decimals", await client.readContract({ address: USDC.address, abi: erc20Abi, functionName: "decimals" }), USDC.decimals);
    eq("USDC symbol", await client.readContract({ address: USDC.address, abi: erc20Abi, functionName: "symbol" }), "USDC");
    eq("WETH decimals", await client.readContract({ address: WETH.address, abi: erc20Abi, functionName: "decimals" }), WETH.decimals);
    eq("feed decimals", await client.readContract({ address: FEED, abi: FEED_ABI, functionName: "decimals" }), 8);
    return `chain ${CHAIN_ID} at block ${head}; USDC, WETH and the ETH/USD feed have code and the expected constants`;
  });

  await step("kit.chain_read", async () => {
    const read = <R>(contract: string, abi: readonly unknown[], name: string) =>
      kit.read<ChainReadOutput<R>>(ACTIONS.chainRead, { kind: "contract_read", chain: "base-sepolia", contract, abi: fragment(abi, name) } satisfies ChainReadInput);
    const dec = await read<string>(USDC.address, erc20Abi, "decimals");
    if (!/^[1-9][0-9]*$/.test(dec.block_number)) throw new Error(`kit block_number is not a block: ${dec.block_number}`);
    eq("kit chain", dec.chain, "base-sepolia");
    eq("kit USDC decimals", dec.result, USDC.decimals);
    eq("kit feed description", (await read<string>(FEED, FEED_ABI, "description")).result, "ETH / USD");
    const round = await read<readonly string[]>(FEED, FEED_ABI, "latestRoundData");
    const answer = BigInt(round.result[1]);
    if (answer <= 0n) throw new Error(`ETH/USD answer ${answer} is not positive`);
    usd.eth_usd = Number(answer) / 1e8;
    const age = Math.max(0, Math.round(Date.now() / 1000 - Number(round.result[3])));
    return `chain.read at block ${dec.block_number}: USDC decimals 6, "ETH / USD" answer ${usd.eth_usd} (updated ${age}s before this run)`;
  });

  await step("kit.tx_simulate", async () => {
    const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [SPENDER, parseUnits("25", 6)] });
    const sim = await kit.read<{ ok: boolean; error: string | null; method: string }>(ACTIONS.txSimulate, {
      chain: "base-sepolia", from: FIXTURE_TAKER, to: USDC.address, data, value: "0",
    });
    if (!sim.ok) throw new Error(`approve simulation failed: ${sim.error}`);
    return `unsigned USDC approve from ${FIXTURE_TAKER} simulated ok via ${sim.method}; nothing was signed`;
  });

  const facts = (token: string, amount: bigint, over: Partial<PreflightFacts> = {}): PreflightFacts => ({
    action: ACTIONS.swapPrepare, chain: "base-sepolia", network: "testnet", token, token_amount_base_units: amount.toString(),
    usd_value: null, usd_spent_today: null, simulation: null, ttl_s: policy.intent_ttl_s, ...over,
  });
  const capRefusal = (f: PreflightFacts) => evaluate(policy, f).refusals.find((r) => r.rule === "max_usd_per_trade");

  await step("preflight.over_cap", async () => {
    const r = capRefusal(facts(USDC.address, parseUnits("100", 6)));
    if (!r) throw new Error("100 USDC was not refused by max_usd_per_trade");
    eq("refusal limit", Number(r.limit), 25);
    eq("refusal observed", Number(r.observed), 100);
    if (usd.eth_usd === null) throw new Error("no ETH/USD answer from step kit.chain_read");
    const w = capRefusal(facts(WETH.address, parseUnits("1", 18)));
    if (usd.eth_usd > 25 && !w) throw new Error(`1 WETH at ${usd.eth_usd} USD was not refused by max_usd_per_trade`);
    return `100 USDC refused: rule=${r.rule} limit=${r.limit} observed=${r.observed}; 1 WETH valued at ${usd.eth_usd} USD ${w ? `refused (observed ${w.observed})` : "within the cap"}`;
  });

  await step("preflight.in_cap_and_network", async () => {
    const inCap = evaluate(policy, facts(USDC.address, parseUnits("10", 6)));
    const caps = inCap.refusals.filter((r) => r.rule === "max_usd_per_trade" || r.rule === "max_usd_per_day");
    if (caps.length) throw new Error(`10 USDC met a USD cap: ${caps.map((r) => r.rule).join(", ")}`);
    const main = evaluate(policy, facts(TOKENS.base.USDC.address, parseUnits("10", 6), { chain: "base", network: "mainnet" }));
    if (!main.refusals.some((r) => r.rule === "network_mainnet_not_enabled")) throw new Error("a mainnet intent was not refused under network testnet");
    return `10 USDC meets no USD cap (other answers: ${inCap.refusals.map((r) => r.rule).join(", ") || "none"}); a mainnet intent is refused by network_mainnet_not_enabled`;
  });

  const failed = steps.filter((s) => !s.ok);
  console.log(`\ntestnet-check: ${steps.length - failed.length}/${steps.length} passed on Base Sepolia. No key was used; nothing was signed or broadcast.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
