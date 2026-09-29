// One kit and one facilitator per run, wired for the chosen mode. No signer in
// any mode: the kit is built with chain.read only, and the seller never signs.
//
//   fixture  no network, no key: recorded RPC answers (fixtures/rpc.json) and
//            the FakeFacilitator.
//   fork     a local anvil fork of Base (ANVIL_RPC_URL) and the ForkFacilitator.
//   testnet  Base Sepolia (SATO_RPC_URL_BASE_SEPOLIA, default
//            https://sepolia.base.org) and the facilitator in config.json
//            (default https://x402.org/facilitator).

import { randomBytes } from "node:crypto";
import { createPublicClient, http, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";
import { chainReadAction, createKit, type Kit, type RpcProvider, type SatoPolicy } from "@satohub/kit";
import type { Mode, NetworkConfig, SellerConfig } from "./config.js";
import { FakeFacilitator, ForkFacilitator, HttpFacilitator, USER_AGENT, type Facilitator } from "./facilitator.js";
import { fixtureTransport, loadRpcFixtures, recordingTransport, type RpcFixtures } from "./fixtures.js";

export { USER_AGENT };
export const TEMPLATE_ID = "x402-seller";
/** Fixture mode's clock. The fixture payments are valid at this instant. */
export const FIXTURE_CLOCK_MS = Date.parse("2026-09-28T00:00:00Z");

export type Runtime = { mode: Mode; kit: Kit; client: PublicClient; net: NetworkConfig; facilitator: Facilitator; nowMs: () => number; recorded?: RpcFixtures };

function kitFor(policy: SatoPolicy, client: PublicClient, clock: () => number): Kit {
  const rpc: RpcProvider = () => client;
  return createKit({ policy, secret: new Uint8Array(randomBytes(32)), rpc, clock, actions: [chainReadAction()], userAgent: USER_AGENT });
}

function uaHttp(url: string) {
  return http(url, { timeout: 30_000, fetchOptions: { headers: { "user-agent": USER_AGENT } } });
}

export async function buildRuntime(opts: { mode: Mode; policy: SatoPolicy; config: SellerConfig; fixturesDir: string; env: NodeJS.ProcessEnv; record?: boolean }): Promise<Runtime> {
  const { mode, env, config } = opts;
  if (mode === "fixture") {
    const net = config.networks.fork;
    const client = createPublicClient({ chain: base, transport: fixtureTransport(loadRpcFixtures(opts.fixturesDir)) }) as PublicClient;
    const nowMs = () => FIXTURE_CLOCK_MS;
    return { mode, kit: kitFor(opts.policy, client, nowMs), client, net, facilitator: new FakeFacilitator(), nowMs };
  }
  if (mode === "fork") {
    const net = config.networks.fork;
    const url = env.ANVIL_RPC_URL;
    if (!url) throw new Error("fork mode needs ANVIL_RPC_URL (e.g. anvil --fork-url https://mainnet.base.org --fork-block-number 51800000 --port 8547, then ANVIL_RPC_URL=http://127.0.0.1:8547)");
    const recorded: RpcFixtures = {};
    const transport = opts.record ? recordingTransport(url, recorded) : uaHttp(url);
    const client = createPublicClient({ chain: base, transport, cacheTime: 0 }) as PublicClient;
    const id = await client.getChainId();
    if (id !== 8453) throw new Error(`ANVIL_RPC_URL answers chain id ${id}; fork mode expects a local fork of Base (8453)`);
    // The fork facilitator sends through anvil's unlocked accounts: a plain
    // (non-recording) client so its writes never land in the fixtures.
    const raw = createPublicClient({ chain: base, transport: uaHttp(url), cacheTime: 0 });
    const rpcRequest = (method: string, params: unknown[]) => raw.request({ method: method as never, params: params as never });
    const nowMs = () => Date.now();
    return { mode, kit: kitFor(opts.policy, client, nowMs), client, net, facilitator: new ForkFacilitator(raw as PublicClient, rpcRequest), nowMs, recorded };
  }
  const net = config.networks.testnet;
  const url = env.SATO_RPC_URL_BASE_SEPOLIA || "https://sepolia.base.org";
  const client = createPublicClient({ chain: baseSepolia, transport: uaHttp(url), cacheTime: 0 }) as PublicClient;
  const id = await client.getChainId();
  if (id !== 84532) throw new Error(`the Base Sepolia RPC answers chain id ${id}; testnet mode expects 84532`);
  const nowMs = () => Date.now();
  return { mode, kit: kitFor(opts.policy, client, nowMs), client, net, facilitator: new HttpFacilitator(net.facilitator), nowMs };
}
