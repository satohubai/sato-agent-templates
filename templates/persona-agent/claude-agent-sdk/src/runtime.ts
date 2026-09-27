// One kit per run, wired for the chosen mode.
//
//   fixture  no network, no key: recorded RPC answers + recorded venue quotes.
//   fork     a local anvil fork of Base (ANVIL_RPC_URL) and a throwaway key the
//            kit generates in memory. The signer is wrapped so it cannot
//            broadcast.
//   testnet  Base Sepolia with a Coinbase CDP managed wallet, wrapped in the
//            kit's humanApprove so a person answers "yes" before every
//            signature. Refuses to start without a managed wallet.

import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { createPublicClient, http, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";
import {
  CORE_ACTIONS,
  cdpSigner,
  createKit,
  humanApprove,
  memoryIntentStore,
  memoryReceiptLog,
  viemLocalSigner,
  type ApprovalSummary,
  type Kit,
  type OdaChain,
  type RpcProvider,
  type SatoPolicy,
  type Signer,
} from "@satohub/kit";
import type { Mode } from "./config.js";
import { fixtureFetch, fixtureTransport, kitFixtureSource, loadHttpFixtures, loadRpcFixtures } from "./fixtures.js";
import { pricedPreflight, SpendLedger, type UsdSource } from "./pricing.js";
import type { ChainName } from "./tokens.js";

export const USER_AGENT = "sato-template/persona-agent@0.1.0";
/** Intents in fixture mode are built for this address. Nobody here holds its key. */
export const FIXTURE_TAKER = "0x000000000000000000000000000000000000dEaD" as const;
export const FIXTURE_CLOCK_MS = Date.parse("2026-09-26T00:00:00Z");

export type Runtime = {
  mode: Mode;
  chain: ChainName;
  kit: Kit;
  signer: Signer | null;
  taker: `0x${string}`;
  policy: SatoPolicy;
  usd: UsdSource;
  ledger: SpendLedger;
  clock: () => number;
};

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

/** Asks the person at the terminal. Anything but "yes" refuses. */
export async function askAtTerminal(s: ApprovalSummary): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const what = s.kind === "evm_tx" ? `transaction to ${s.tx.to}, value ${s.tx.value} wei, chain ${s.tx.chain_id}` : "typed-data signature";
    const a = await rl.question(`\nApprove signing a ${what}? Type "yes" to sign: `);
    return a.trim() === "yes";
  } finally {
    rl.close();
  }
}

export async function buildRuntime(opts: { mode: Mode; policy: SatoPolicy; fixturesDir: string; env: NodeJS.ProcessEnv; approve?: (s: ApprovalSummary) => Promise<boolean> }): Promise<Runtime> {
  const secret = new Uint8Array(randomBytes(32));
  const { mode, env } = opts;
  const usd: UsdSource = { eth_usd: null };

  if (mode === "fixture") {
    const client = createPublicClient({ chain: base, transport: fixtureTransport(loadRpcFixtures(opts.fixturesDir)) }) as PublicClient;
    const clock = () => FIXTURE_CLOCK_MS;
    const ledger = new SpendLedger(clock);
    const kit = createKit({
      policy: opts.policy,
      secret,
      rpc: () => client,
      fetch: fixtureFetch(loadHttpFixtures(opts.fixturesDir)),
      fixtures: kitFixtureSource(opts.fixturesDir),
      clock,
      evaluate: pricedPreflight(() => usd, ledger),
      actions: CORE_ACTIONS.list(),
      intents: memoryIntentStore(),
      receipts: memoryReceiptLog(),
      userAgent: USER_AGENT,
    });
    return { mode, chain: "base", kit, signer: null, taker: FIXTURE_TAKER, policy: opts.policy, usd, ledger, clock };
  }

  if (mode === "fork") {
    const url = env.ANVIL_RPC_URL;
    if (!url) throw new Error("fork mode needs ANVIL_RPC_URL (anvil --fork-url https://mainnet.base.org, then ANVIL_RPC_URL=http://127.0.0.1:8545)");
    const client = createPublicClient({ chain: base, transport: http(url, { timeout: 30_000 }) }) as PublicClient;
    const chainId = await client.getChainId();
    if (chainId !== 8453) throw new Error(`ANVIL_RPC_URL answers chain id ${chainId}; fork mode expects a fork of Base (8453)`);
    const rpc: RpcProvider = () => client;
    const signer = noBroadcast(viemLocalSigner({ generate: true, rpc }));
    const clock = () => Date.now();
    const ledger = new SpendLedger(clock);
    const kit = createKit({
      policy: { ...opts.policy, network: "fork" },
      secret,
      rpc,
      signer,
      evaluate: pricedPreflight(() => usd, ledger),
      actions: CORE_ACTIONS.list(),
      intents: memoryIntentStore(),
      receipts: memoryReceiptLog(),
      userAgent: USER_AGENT,
    });
    return { mode, chain: "base", kit, signer, taker: await signer.address("base"), policy: opts.policy, usd, ledger, clock };
  }

  const missing = ["BASE_SEPOLIA_RPC_URL", "CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`testnet mode needs a managed wallet and refuses to run without one. Missing: ${missing.join(", ")}. There is no raw-private-key option.`);
  let cdp: { CdpClient: new (o: Record<string, string>) => { evm: { getOrCreateAccount(o: { name: string }): Promise<unknown> } } };
  try {
    cdp = (await import("@coinbase/cdp-sdk" as string)) as typeof cdp;
  } catch {
    throw new Error("testnet mode needs the Coinbase CDP SDK: npm install @coinbase/cdp-sdk (see README).");
  }
  const client = createPublicClient({ chain: baseSepolia, transport: http(env.BASE_SEPOLIA_RPC_URL, { timeout: 30_000 }) }) as PublicClient;
  const rpc: RpcProvider = (c: OdaChain) => {
    if (c !== "base-sepolia") throw new Error(`testnet mode reads base-sepolia only, not ${c}`);
    return client;
  };
  const cdpClient = new cdp.CdpClient({ apiKeyId: env.CDP_API_KEY_ID!, apiKeySecret: env.CDP_API_KEY_SECRET!, walletSecret: env.CDP_WALLET_SECRET! });
  const account = await cdpClient.evm.getOrCreateAccount({ name: "persona-agent" });
  const signer = humanApprove(cdpSigner({ account }), opts.approve ?? askAtTerminal);
  const clock = () => Date.now();
  const ledger = new SpendLedger(clock);
  const policy: SatoPolicy = { ...opts.policy, network: "testnet" };
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
  return { mode, chain: "base-sepolia", kit, signer, taker: await signer.address("base-sepolia"), policy, usd, ledger, clock };
}
