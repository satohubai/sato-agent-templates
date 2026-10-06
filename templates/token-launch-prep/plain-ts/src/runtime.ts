// One kit per run, wired for the chosen mode. No signer in any mode.
//
//   fixture  no network, no key: recorded RPC answers in fixtures/rpc.json
//            (recorded from an anvil fork of Base at block 51800000).
//   fork     a local anvil fork of Base (ANVIL_RPC_URL).
//   rpc      an RPC endpoint you name (--rpc or SATO_RPC_URL_BASE), Base or
//            Base Sepolia. Read-only calls only: eth_call and eth_estimateGas.
//
// The kit is built with NO signer and with one action, tx.simulate, whose
// effects are ["simulate"]: it runs eth_call + eth_estimateGas and cannot
// sign or send. There is no wallet client anywhere in this template.

import { randomBytes } from "node:crypto";
import { createPublicClient, http, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";
import { createKit, txSimulateAction, type Kit, type SatoPolicy } from "@satohub/kit";
import type { LaunchChain } from "./clanker.js";
import type { Mode } from "./config.js";
import { fixtureTransport, loadRpcFixtures, recordingTransport, type RpcFixtures } from "./fixtures.js";

export const TEMPLATE_ID = "token-launch-prep";
export const TEMPLATE_VERSION = "0.1.0";
export const USER_AGENT = `sato-template/${TEMPLATE_ID}@${TEMPLATE_VERSION}`;
export const FIXTURE_CLOCK_MS = Date.parse("2026-10-06T00:00:00Z");
/** The Base block the fixtures were recorded at and the nightly fork check runs at. */
export const PINNED_BLOCK = 51800000n;

export type Runtime = {
  mode: Mode;
  kit: Kit;
  client: PublicClient;
  /** The one chain this run's RPC answers. */
  chain: LaunchChain;
  clock: () => number;
  recorded?: RpcFixtures;
};

export function kitFor(policy: SatoPolicy, client: PublicClient, clock: () => number): Kit {
  return createKit({
    policy,
    secret: new Uint8Array(randomBytes(32)),
    rpc: () => client,
    clock,
    actions: [txSimulateAction()],
    userAgent: USER_AGENT,
  });
}

/** An http transport that names this template in its user-agent. */
export function uaHttp(url: string) {
  return http(url, { timeout: 30_000, fetchOptions: { headers: { "user-agent": USER_AGENT } } });
}

const CHAIN_BY_ID: Record<number, LaunchChain> = { 8453: "base", 84532: "base-sepolia" };

export async function buildRuntime(opts: { mode: Mode; policy: SatoPolicy; fixturesDir: string; env: NodeJS.ProcessEnv; rpcUrl?: string; record?: boolean }): Promise<Runtime> {
  const { mode, env } = opts;
  if (mode === "fixture") {
    const client = createPublicClient({ chain: base, transport: fixtureTransport(loadRpcFixtures(opts.fixturesDir)) }) as PublicClient;
    const clock = () => FIXTURE_CLOCK_MS;
    return { mode, kit: kitFor(opts.policy, client, clock), client, chain: "base", clock };
  }

  if (mode === "fork") {
    const url = env.ANVIL_RPC_URL;
    if (!url) throw new Error("fork mode needs ANVIL_RPC_URL (e.g. anvil --fork-url https://mainnet.base.org --fork-block-number 51800000 --port 8547, then ANVIL_RPC_URL=http://127.0.0.1:8547)");
    const recorded: RpcFixtures = {};
    const transport = opts.record ? recordingTransport(url, recorded) : uaHttp(url);
    const client = createPublicClient({ chain: base, transport }) as PublicClient;
    const id = await client.getChainId();
    if (id !== 8453) throw new Error(`ANVIL_RPC_URL answers chain id ${id}; fork mode expects a fork of Base (8453)`);
    const clock = () => Date.now();
    return { mode, kit: kitFor(opts.policy, client, clock), client, chain: "base", clock, recorded };
  }

  const url = opts.rpcUrl;
  if (!url) throw new Error("rpc mode needs --rpc <url> or SATO_RPC_URL_BASE");
  const probe = createPublicClient({ transport: uaHttp(url) });
  const id = await probe.getChainId();
  const chain = CHAIN_BY_ID[id];
  if (!chain) throw new Error(`the RPC answers chain id ${id}; this template simulates on Base (8453) or Base Sepolia (84532)`);
  const client = createPublicClient({ chain: chain === "base" ? base : baseSepolia, transport: uaHttp(url) }) as PublicClient;
  const clock = () => Date.now();
  return { mode, kit: kitFor(opts.policy, client, clock), client, chain, clock };
}
