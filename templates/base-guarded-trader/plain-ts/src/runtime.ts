// One kit per run, wired for the chosen mode.
//
//   fixture  no network, no key: recorded RPC answers + recorded venue quotes.
//   sato-os  no key: the same read-only kit as fixture mode, but reading Base
//            through BASE_RPC_URL (or the recordings with --data fixture),
//            with intents built for the wallet attached to Sato OS. Allowed
//            intents are handed to Sato OS as proposals (src/sato-os.ts).
//   fork     a local anvil fork of Base (ANVIL_RPC_URL) and a throwaway key the
//            kit generates in memory, funded with anvil_setBalance. The signer
//            is wrapped so it cannot broadcast.
//   testnet  Base Sepolia with a Coinbase CDP managed wallet. Refuses to start
//            without one; there is no raw-key path.

import { randomBytes } from "node:crypto";
import { createPublicClient, http, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";
import {
  CORE_ACTIONS,
  cdpSigner,
  createKit,
  memoryIntentStore,
  memoryReceiptLog,
  viemLocalSigner,
  type Kit,
  type OdaChain,
  type RpcProvider,
  type SatoPolicy,
  type Signer,
} from "@satohub/kit";
import type { Mode } from "./config.js";
import { fixtureFetch, fixtureTransport, kitFixtureSource, loadHttpFixtures, loadRpcFixtures, recordingFetch, recordingTransport, type HttpFixture, type RpcFixtures } from "./fixtures.js";
import { pricedPreflight, SpendLedger, type UsdSource } from "./pricing.js";
import type { ChainName } from "./tokens.js";

export const USER_AGENT = "sato-template/base-guarded-trader@0.1.0";
export const FORK_FUNDING_WEI = 10n ** 18n; // 1 ETH of fork-only gas money
/**
 * Fixture mode holds no key, and --record builds intents for this fixed
 * address so the recordings (allowance reads, simulations) are reproducible.
 * It is an address only; nobody here holds its key and nothing is sent from it.
 */
export const FIXTURE_TAKER = "0x000000000000000000000000000000000000dEaD" as const;
export const FIXTURE_CLOCK_MS = Date.parse("2026-09-26T00:00:00Z");

export type Runtime = {
  mode: Mode;
  chain: ChainName;
  kit: Kit;
  client: PublicClient;
  signer: Signer | null;
  /** Address intents are built for. In fixture mode (and fork --record) the fixed FIXTURE_TAKER, which holds no key here. */
  taker: `0x${string}`;
  policy: SatoPolicy;
  /** The prices the pre-flight's USD facts come from; the agent sets eth_usd after reading the market. */
  usd: UsdSource;
  ledger: SpendLedger;
  recorded?: RpcFixtures;
  recordedHttp?: HttpFixture[];
};

/** A signer that can simulate and sign typed data but can never broadcast. Used on the fork. */
export function noBroadcast(inner: Signer): Signer {
  return {
    kind: inner.kind,
    address: (c) => inner.address(c),
    signTypedData: (td) => inner.signTypedData(td),
    async sendTransaction() {
      throw new Error("this template never broadcasts on a fork");
    },
    nativePolicy: inner.nativePolicy,
  };
}

function viemChain(chain: ChainName) {
  return chain === "base" ? base : baseSepolia;
}

export async function buildRuntime(opts: {
  mode: Mode;
  policy: SatoPolicy;
  fixturesDir: string;
  env: NodeJS.ProcessEnv;
  record?: boolean;
  /** fork only: serve venue quotes from fixtures/http instead of the network. */
  recordedQuotes?: boolean;
  /** --mode sato-os: rpcUrl null = answer from the recordings; taker = the Sato OS wallet. */
  satoOs?: { rpcUrl: string | null; taker: `0x${string}` };
}): Promise<Runtime> {
  const secret = new Uint8Array(randomBytes(32)); // intent-id HMAC secret, memory only
  const { mode, env } = opts;

  if (mode === "fixture" || mode === "sato-os") {
    const chain: ChainName = "base";
    const live = mode === "sato-os" && opts.satoOs?.rpcUrl ? opts.satoOs.rpcUrl : null;
    if (mode === "sato-os" && !opts.satoOs) throw new Error("sato-os mode needs the attached wallet");
    const taker = mode === "sato-os" ? opts.satoOs!.taker : FIXTURE_TAKER;
    const transport = live ? http(live, { timeout: 30_000 }) : fixtureTransport(loadRpcFixtures(opts.fixturesDir));
    const client = createPublicClient({ chain: base, transport }) as PublicClient;
    const rpc: RpcProvider = () => client;
    const usd: UsdSource = { eth_usd: null };
    const clock = live ? () => Date.now() : () => FIXTURE_CLOCK_MS;
    const ledger = new SpendLedger(clock);
    const kit = createKit({
      policy: opts.policy,
      secret,
      rpc,
      ...(live ? { fetch: globalThis.fetch } : { fetch: fixtureFetch(loadHttpFixtures(opts.fixturesDir)), fixtures: kitFixtureSource(opts.fixturesDir) }),
      clock,
      evaluate: pricedPreflight(() => usd, ledger),
      actions: CORE_ACTIONS.list(),
      intents: memoryIntentStore(),
      receipts: memoryReceiptLog(),
      userAgent: USER_AGENT,
    });
    return { mode, chain, kit, client, signer: null, taker, policy: opts.policy, usd, ledger };
  }

  if (mode === "fork") {
    const url = env.ANVIL_RPC_URL;
    if (!url) throw new Error("fork mode needs ANVIL_RPC_URL (e.g. anvil --fork-url https://mainnet.base.org, then ANVIL_RPC_URL=http://127.0.0.1:8545)");
    const recorded: RpcFixtures = {};
    const transport = opts.record ? recordingTransport(url, recorded) : http(url, { timeout: 30_000 });
    const client = createPublicClient({ chain: base, transport }) as PublicClient;
    const chainId = await client.getChainId();
    if (chainId !== 8453) throw new Error(`ANVIL_RPC_URL answers chain id ${chainId}; fork mode expects a fork of Base (8453)`);
    const rpc: RpcProvider = () => client;
    const signer = noBroadcast(viemLocalSigner({ generate: true, rpc }));
    const own = await signer.address("base");
    // Fork-only money: anvil_setBalance exists only on a local dev node.
    await client.request({ method: "anvil_setBalance" as never, params: [own, `0x${FORK_FUNDING_WEI.toString(16)}`] as never });
    const taker = opts.record ? FIXTURE_TAKER : own;
    const recordedHttp: HttpFixture[] = [];
    const venueFetch: typeof fetch = opts.recordedQuotes
      ? fixtureFetch(loadHttpFixtures(opts.fixturesDir))
      : opts.record
        ? recordingFetch(globalThis.fetch, recordedHttp)
        : globalThis.fetch;
    const usd: UsdSource = { eth_usd: null };
    const ledger = new SpendLedger(() => Date.now());
    const kit = createKit({
      policy: { ...opts.policy, network: "fork" },
      secret,
      rpc,
      signer,
      fetch: venueFetch,
      evaluate: pricedPreflight(() => usd, ledger),
      actions: CORE_ACTIONS.list(),
      intents: memoryIntentStore(),
      receipts: memoryReceiptLog(),
      userAgent: USER_AGENT,
    });
    return { mode, chain: "base", kit, client, signer, taker, policy: opts.policy, usd, ledger, recorded, recordedHttp };
  }

  // testnet
  const url = env.BASE_SEPOLIA_RPC_URL;
  const missing = ["BASE_SEPOLIA_RPC_URL", "CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"].filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`testnet mode needs a managed wallet and refuses to run without one. Missing: ${missing.join(", ")}. See README "Testnet with a CDP wallet". There is no raw-private-key option.`);
  }
  let cdp: { CdpClient: new (o: Record<string, string>) => { evm: { getOrCreateAccount(o: { name: string }): Promise<unknown> } } };
  try {
    cdp = (await import("@coinbase/cdp-sdk" as string)) as typeof cdp;
  } catch {
    throw new Error("testnet mode needs the Coinbase CDP SDK: npm install @coinbase/cdp-sdk (see README). Refusing to run without a managed wallet.");
  }
  const client = createPublicClient({ chain: viemChain("base-sepolia"), transport: http(url, { timeout: 30_000 }) }) as PublicClient;
  const rpc: RpcProvider = (c: OdaChain) => {
    if (c !== "base-sepolia") throw new Error(`testnet mode reads base-sepolia only, not ${c}`);
    return client;
  };
  const cdpClient = new cdp.CdpClient({
    apiKeyId: env.CDP_API_KEY_ID!,
    apiKeySecret: env.CDP_API_KEY_SECRET!,
    walletSecret: env.CDP_WALLET_SECRET!,
  });
  const account = await cdpClient.evm.getOrCreateAccount({ name: "base-guarded-trader" });
  const signer = cdpSigner({ account });
  const taker = await signer.address("base-sepolia");
  const policy: SatoPolicy = { ...opts.policy, network: "testnet" };
  const usd: UsdSource = { eth_usd: null };
  const ledger = new SpendLedger(() => Date.now());
  const kit = createKit({
    policy,
    secret,
    rpc,
    signer,
    evaluate: pricedPreflight(() => usd, ledger),
    actions: CORE_ACTIONS.list(),
    intents: memoryIntentStore(),
    receipts: memoryReceiptLog(),
    userAgent: USER_AGENT,
  });
  return { mode, chain: "base-sepolia", kit, client, signer, taker, policy, usd, ledger };
}
