// One kit per run, wired for the chosen mode. No mode has a signer.
//
//   fixture  no network, no key: recorded Solana RPC answers and recorded venue
//            responses, built for a fixed public wallet.
//   live     Solana mainnet through SOLANA_RPC_URL (read-only calls and
//            simulateTransaction), plus live Jupiter and Sato Route requests.
//            Needs --accept-mainnet-risk. Still no signer: the run ends at an
//            unsigned transaction.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  createKit,
  memoryIntentStore,
  memoryReceiptLog,
  solanaActions,
  solanaJsonRpc,
  type Kit,
  type SatoPolicy,
  type SolanaRpc,
} from "@satohub/kit";
import type { Mode } from "./config.js";
import { fixtureFetch, fixtureSolanaRpc, loadHttpFixtures, loadRpcFixtures, recordingFetch, recordingSolanaRpc, type HttpFixture, type RpcFixtures } from "./fixtures.js";
import { kitPolicy } from "./policy.js";
import { ledgerPreflight, SpendLedger } from "./spend.js";

export const USER_AGENT = "sato-template/solana-guarded-swapper@0.1.0";
export const DEFAULT_MAINNET_RPC = "https://api.mainnet-beta.solana.com";

/**
 * Fixture mode holds no key, and --record builds intents for this fixed public
 * address so the recordings (balance read, simulation) are reproducible. It is
 * an address only: nobody here holds its key and nothing is sent from it.
 */
export const FIXTURE_WALLET = "7PdKhpKz7T39vZHFL1UfcYNDsLvay6hp4KPQq1aUckFf" as const;
export const FIXTURE_CLOCK_MS = Date.parse("2026-10-09T01:00:00Z");

export type Runtime = {
  mode: Mode;
  kit: Kit;
  /** The public address intents are built for. */
  wallet: string;
  policy: SatoPolicy;
  ledger: SpendLedger;
  rpcHost: string | null;
  recorded?: RpcFixtures;
  recordedHttp?: HttpFixture[];
};

export async function buildRuntime(opts: {
  mode: Mode;
  policy: SatoPolicy;
  fixturesDir: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  /** live: the wallet from config.json. */
  wallet: string | null;
  record?: boolean;
  /** Tests only: replace the RPC, the venue fetch or the clock. */
  inject?: { rpc?: SolanaRpc; fetch?: typeof fetch; clock?: () => number };
}): Promise<Runtime> {
  const secret = new Uint8Array(randomBytes(32)); // intent-id HMAC secret, memory only
  const { mode, env } = opts;
  const recorded: RpcFixtures = {};
  const recordedHttp: HttpFixture[] = [];

  let rpc: SolanaRpc;
  let venueFetch: typeof fetch;
  let clock: () => number;
  let wallet: string;
  let rpcHost: string | null = null;

  if (mode === "fixture") {
    rpc = fixtureSolanaRpc(loadRpcFixtures(opts.fixturesDir));
    venueFetch = fixtureFetch(loadHttpFixtures(opts.fixturesDir));
    clock = () => FIXTURE_CLOCK_MS;
    wallet = FIXTURE_WALLET;
  } else {
    const url = env.SOLANA_RPC_URL || DEFAULT_MAINNET_RPC;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error("SOLANA_RPC_URL is not a URL");
    }
    if (u.protocol !== "https:") throw new Error("SOLANA_RPC_URL must be an https URL");
    rpcHost = u.host;
    const live = solanaJsonRpc(url, { userAgent: USER_AGENT });
    rpc = opts.record ? recordingSolanaRpc(live, recorded) : live;
    venueFetch = opts.record ? recordingFetch(globalThis.fetch, recordedHttp) : globalThis.fetch;
    clock = () => Date.now();
    if (opts.record) wallet = FIXTURE_WALLET;
    else {
      if (!opts.wallet) throw new Error('live mode needs your public address: set "wallet" in config.json (an address, never a key).');
      wallet = opts.wallet;
    }
  }

  if (opts.inject?.rpc) rpc = opts.inject.rpc;
  if (opts.inject?.fetch) venueFetch = opts.inject.fetch;
  if (opts.inject?.clock) clock = opts.inject.clock;

  const ledger = new SpendLedger(clock, mode === "live" && !opts.record ? join(opts.stateDir, "ledger.json") : null);
  const kit = createKit({
    policy: kitPolicy(opts.policy),
    secret,
    // The kit asks for an EVM provider too; this template reads Solana only.
    rpc: () => {
      throw new Error("solana-guarded-swapper reads Solana only; it has no EVM RPC");
    },
    solanaRpc: () => rpc,
    fetch: venueFetch,
    clock,
    evaluate: ledgerPreflight(ledger),
    actions: solanaActions(),
    intents: memoryIntentStore(),
    receipts: memoryReceiptLog(),
    userAgent: USER_AGENT,
  });
  return { mode, kit, wallet, policy: opts.policy, ledger, rpcHost, recorded, recordedHttp };
}
