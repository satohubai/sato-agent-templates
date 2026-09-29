// The weekly Base Sepolia step. Keyless: against the public Base Sepolia RPC
// (BASE_SEPOLIA_RPC_URL), with the testnet network from config.json:
//   0. testnet sanity (plain viem, no kit): chain id matches the configured
//      network, contract code at the configured asset, and its decimals,
//      name() and version() equal what config.json says — the EIP-712 domain
//      a payer's authorization is signed under, so a mismatch here means
//      every testnet payment would be rejected;
//   1. the settlement read the seller relies on, through the kit's chain.read:
//      authorizationState for a nonce nobody has used answers "not used" at a
//      block, so confirmSettlement reports it unconfirmed for that reason (and
//      not because the read failed), and the payee's balance answers as a
//      decimal string (balances move on a live chain; only the shape is checked).
// The facilitator is never contacted, the seller holds no key, and nothing is
// signed or sent.
//
//   BASE_SEPOLIA_RPC_URL=https://sepolia.base.org npm run testnet-check

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { chainReadAction, createKit } from "@satohub/kit";
import { createPublicClient, erc20Abi, http, type Address, type PublicClient } from "viem";
import { baseSepolia } from "viem/chains";
import type { SellerConfig } from "../src/config.js";
import { confirmSettlement } from "../src/confirm.js";
import { ACTIONS, type ChainReadOutput } from "../src/kit-io.js";
import { loadPolicy } from "../src/policy.js";
import { USER_AGENT } from "../src/runtime.js";

/** A fixed nonce and payer. No authorization under this nonce is expected to exist; nobody here holds the payer's key. */
const NEVER_USED_NONCE = `0x${"5a70".repeat(16)}` as const;
const PAYER: Address = "0x000000000000000000000000000000000000dEaD";
const DOMAIN_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

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
  const config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8")) as SellerConfig;
  const net = config.networks.testnet;
  const asset = net.asset as Address;
  const policy = { ...loadPolicy(new URL("../policy.json", import.meta.url).pathname), network: "testnet" as const };
  const client = createPublicClient({ chain: baseSepolia, transport: http(url, { timeout: 30_000, fetchOptions: { headers: { "user-agent": USER_AGENT } } }) }) as PublicClient;
  const kit = createKit({ policy, secret: new Uint8Array(randomBytes(32)), rpc: () => client, clock: () => Date.now(), actions: [chainReadAction()], userAgent: USER_AGENT });

  await step("testnet.sanity", async () => {
    eq("configured chain", net.chain, "base-sepolia");
    eq("chain id", `eip155:${await client.getChainId()}`, net.network);
    const code = await client.getCode({ address: asset });
    if (!code || code === "0x") throw new Error(`no contract code at ${net.asset_symbol} ${asset}`);
    eq(`${net.asset_symbol} decimals`, await client.readContract({ address: asset, abi: erc20Abi, functionName: "decimals" }), net.asset_decimals);
    eq("EIP-712 name", await client.readContract({ address: asset, abi: DOMAIN_ABI, functionName: "name" }), net.eip712.name);
    eq("EIP-712 version", await client.readContract({ address: asset, abi: DOMAIN_ABI, functionName: "version" }), net.eip712.version);
    return `${net.network}: ${net.asset_symbol} at ${asset} has code, ${net.asset_decimals} decimals and the configured EIP-712 domain (${net.eip712.name}, ${net.eip712.version})`;
  });

  await step("kit.settlement_read", async () => {
    const c = await confirmSettlement(kit, "base-sepolia", asset, PAYER, NEVER_USED_NONCE);
    eq("confirmation status", c.status, "unconfirmed");
    if (c.status !== "unconfirmed") throw new Error("unreachable");
    if (!c.block_number || !/^[1-9][0-9]*$/.test(c.block_number)) throw new Error(`the read did not answer at a block: ${c.reason}`);
    eq("reason", c.reason, "the token does not report this authorization as used");
    const bal = await kit.read<ChainReadOutput<string>>(ACTIONS.chainRead, { kind: "erc20_balance", chain: "base-sepolia", token: asset, owner: config.service.pay_to });
    if (!/^[0-9]+$/.test(String(bal.result))) throw new Error(`payee balance is not a decimal string: ${bal.result}`);
    return `authorizationState answered "not used" at block ${c.block_number}; the payee balance read answers`;
  });

  const failed = steps.filter((s) => !s.ok);
  console.log(`\ntestnet-check: ${steps.length - failed.length}/${steps.length} passed on Base Sepolia. The facilitator was not contacted; nothing was signed or sent.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
