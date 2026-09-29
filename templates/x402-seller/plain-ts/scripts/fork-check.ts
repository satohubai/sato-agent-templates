// The nightly fork step. Against an anvil fork of Base at the PINNED block:
//   0. fork sanity: chain id and block;
//   1. fund the fixture payer on the fork (anvil impersonation; no key);
//   2. the fixture's valid payment through the real payment gate with the
//      ForkFacilitator: 200, a real transferWithAuthorization on the fork, the
//      settlement confirmed through the kit's chain.read (authorizationState),
//      and the payee's USDC balance up by exactly the route price;
//   3. the same payment again: refused, nonce already used.
// The seller holds no key: the facilitator sends from anvil's unlocked dev account.
//
//   ANVIL_RPC_URL=http://127.0.0.1:8547 npm run fork-check [-- --record]
//   --record rewrites fixtures/rpc.json from the kit's reads in step 2.

import { readFileSync } from "node:fs";
import { createPublicClient, encodeFunctionData, erc20Abi, http, type Address } from "viem";
import { base } from "viem/chains";
import { loadPayment, runScenario, type Scenario } from "../src/agent.js";
import type { SellerConfig } from "../src/config.js";
import { writeRpcFixtures } from "../src/fixtures.js";
import { ACTIONS, type ChainReadOutput } from "../src/kit-io.js";
import { loadPolicy } from "../src/policy.js";
import { buildRuntime, type Runtime } from "../src/runtime.js";

const PINNED_BLOCK = 51800000n;
/** A contract that holds USDC on Base at the pinned block (the WETH predeploy); impersonated on the fork only. */
const FUNDER: Address = "0x4200000000000000000000000000000000000006";
const FIXTURES = new URL("../fixtures", import.meta.url).pathname;

type Step = { id: string; ok: boolean; detail: string };
const steps: Step[] = [];
async function step(id: string, fn: () => Promise<string>) {
  try { const d = await fn(); steps.push({ id, ok: true, detail: d }); console.log(`ok   ${id} — ${d}`); }
  catch (e) { const d = e instanceof Error ? e.message.split("\n")[0] : String(e); steps.push({ id, ok: false, detail: d }); console.log(`FAIL ${id} — ${d}`); }
}
function eq(label: string, got: unknown, want: unknown) {
  if (String(got) !== String(want)) throw new Error(`${label}: expected ${String(want)}, got ${String(got)}`);
}
const scenario = (f: string) => JSON.parse(readFileSync(`${FIXTURES}/scenarios/${f}.json`, "utf8")) as Scenario;

async function main() {
  const record = process.argv.includes("--record");
  const url = (process.env.ANVIL_RPC_URL ??= "http://127.0.0.1:8547");
  const config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8")) as SellerConfig;
  const policy = loadPolicy(new URL("../policy.json", import.meta.url).pathname);
  const c = createPublicClient({ chain: base, transport: http(url, { fetchOptions: { headers: { "user-agent": "SatoHub-templates-ci/1.0" } } }) });
  const rpc = (method: string, params: unknown[]) => c.request({ method: method as never, params: params as never });
  const usdc = config.networks.fork.asset as Address;
  const payTo = config.service.pay_to as Address;
  const price = BigInt(config.routes[0].price_base_units);
  const payer = loadPayment(FIXTURES, "valid").payload.authorization.from as Address;
  let rt: Runtime | null = null;
  let before = 0n;

  await step("fork.sanity", async () => {
    eq("chain id", await c.getChainId(), 8453);
    const b = await c.getBlockNumber();
    if (b < PINNED_BLOCK) throw new Error(`block ${b} is before the pinned ${PINNED_BLOCK}`);
    return `a fork of Base from block ${PINNED_BLOCK} (now at ${b})`;
  });

  await step("fork.fund_payer", async () => {
    await rpc("anvil_impersonateAccount", [FUNDER]);
    await rpc("anvil_setBalance", [FUNDER, "0xde0b6b3a7640000"]);
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [payer, price] });
    const hash = (await rpc("eth_sendTransaction", [{ from: FUNDER, to: usdc, data }])) as `0x${string}`;
    await c.waitForTransactionReceipt({ hash, timeout: 30_000 });
    await rpc("anvil_stopImpersonatingAccount", [FUNDER]);
    const bal = await c.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [payer] });
    if (bal < price) throw new Error(`payer holds ${bal}, needs ${price}`);
    return `fixture payer ${payer} holds ${bal} base units on the fork`;
  });

  await step("gate.paid", async () => {
    rt = await buildRuntime({ mode: "fork", policy, config, fixturesDir: FIXTURES, env: process.env, record });
    const pre = await rt.kit.read<ChainReadOutput<string>>(ACTIONS.chainRead, { kind: "erc20_balance", chain: "base", token: usdc, owner: payTo });
    before = BigInt(pre.result);
    const r = await runScenario(rt, config, "02-paid", scenario("02-paid"), FIXTURES);
    eq("status", r.status, 200);
    if (!r.receipt) throw new Error("no receipt");
    if (r.receipt.confirmation.status !== "confirmed") throw new Error(`settlement unconfirmed: ${r.receipt.confirmation.reason}`);
    const post = await rt.kit.read<ChainReadOutput<string>>(ACTIONS.chainRead, { kind: "erc20_balance", chain: "base", token: usdc, owner: payTo });
    eq("payee balance delta", BigInt(post.result) - before, price);
    return `settled in ${r.receipt.transaction}; authorizationState true at block ${r.receipt.confirmation.block_number}; payee +${price} base units`;
  });

  await step("gate.replay", async () => {
    if (!rt) throw new Error("no runtime");
    const r = await runScenario(rt, config, "03-replay", scenario("03-replay"), FIXTURES);
    eq("status", r.status, 402);
    eq("reason", r.refused_reason, "nonce_already_used");
    return "the same authorization is refused: nonce_already_used";
  });

  if (record && rt && (rt as Runtime).recorded) {
    writeRpcFixtures(FIXTURES, (rt as Runtime).recorded!, { recorded_from: `anvil fork of Base from block ${PINNED_BLOCK}, after the fixture payment was settled on the fork`, note: "written by npm run fork-check -- --record" });
    console.log("Recorded the kit's reads into fixtures/rpc.json");
  }
  const failed = steps.filter((s) => !s.ok).length;
  console.log(`\n${steps.length - failed}/${steps.length} fork steps passed. Nothing was broadcast outside the local fork.`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
