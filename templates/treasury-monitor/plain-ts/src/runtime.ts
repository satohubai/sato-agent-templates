// One kit per run, wired for the chosen mode. No signer in any mode.
//
//   fixture  no network, no key: recorded RPC answers in fixtures/rpc.json.
//   fork     a local anvil fork of Base (ANVIL_RPC_URL).
//   rpc      an RPC endpoint you name (--rpc or SATO_RPC_URL_BASE), Base or
//            Base Sepolia, read-only.
//
// The kit is built with no signer, so it cannot sign or send in any mode; the
// only action this template calls is chain.read.

import { randomBytes } from "node:crypto";
import { createPublicClient, http, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";
import { chainReadAction, createKit, type Kit, type RpcProvider, type SatoPolicy } from "@satohub/kit";
import type { Mode } from "./config.js";
import { fixtureTransport, loadRpcFixtures, recordingTransport, type RpcFixtures } from "./fixtures.js";
import type { ChainName } from "./kit-io.js";

export const TEMPLATE_ID = "treasury-monitor";
export const USER_AGENT = "sato-template/treasury-monitor@0.1.0";
export const FIXTURE_CLOCK_MS = Date.parse("2026-09-26T00:00:00Z");

export type Runtime = {
  mode: Mode;
  kit: Kit;
  client: PublicClient;
  chains: ChainName[];
  clock: () => number;
  recorded?: RpcFixtures;
};

function kitFor(policy: SatoPolicy, client: PublicClient, clock: () => number): Kit {
  const rpc: RpcProvider = () => client;
  return createKit({
    policy,
    secret: new Uint8Array(randomBytes(32)),
    rpc,
    clock,
    actions: [chainReadAction()],
    userAgent: USER_AGENT,
  });
}

/** An http transport that names this template in its user-agent. */
function uaHttp(url: string) {
  return http(url, { timeout: 30_000, fetchOptions: { headers: { "user-agent": USER_AGENT } } });
}

export async function buildRuntime(opts: { mode: Mode; policy: SatoPolicy; fixturesDir: string; env: NodeJS.ProcessEnv; rpcUrl?: string; record?: boolean }): Promise<Runtime> {
  const { mode, env } = opts;
  if (mode === "fixture") {
    const client = createPublicClient({ chain: base, transport: fixtureTransport(loadRpcFixtures(opts.fixturesDir)) }) as PublicClient;
    const clock = () => FIXTURE_CLOCK_MS;
    return { mode, kit: kitFor(opts.policy, client, clock), client, chains: ["base"], clock };
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
    return { mode, kit: kitFor(opts.policy, client, clock), client, chains: ["base"], clock, recorded };
  }

  const url = opts.rpcUrl;
  if (!url) throw new Error("rpc mode needs --rpc <url> or SATO_RPC_URL_BASE");
  const probe = createPublicClient({ transport: uaHttp(url) });
  const id = await probe.getChainId();
  const chain: ChainName | null = id === 8453 ? "base" : id === 84532 ? "base-sepolia" : null;
  if (!chain) throw new Error(`the RPC answers chain id ${id}; this template reads Base (8453) or Base Sepolia (84532)`);
  const client = createPublicClient({ chain: chain === "base" ? base : baseSepolia, transport: uaHttp(url) }) as PublicClient;
  const clock = () => Date.now();
  return { mode, kit: kitFor(opts.policy, client, clock), client, chains: [chain], clock };
}
