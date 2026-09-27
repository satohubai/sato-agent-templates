// Coinbase AgentKit wiring. The kit's tools reach AgentKit through ONE action
// provider, satoKitActionProvider from "@satohub/kit/agentkit"; this file adds
// no tool of its own and names no tool the kit does not publish.
//
//   AgentKit.from({ walletProvider, actionProviders: [satoKitActionProvider(kit, …)] })
//
// Every action returns the kit's envelope as JSON:
//   { ok: true, tool, result }  |  { ok: false, tool, error: { code, message, refusals? }, intent? }
//
// execute: the provider refuses it unless it was built with an `approve`
// callback that answers true. Fixture and fork runs build it WITHOUT one, so
// execute is refused there by the provider itself (code approval_required).

import { AgentKit, WalletProvider, type Action, type Network } from "@coinbase/agentkit";
import { satoKitActionProvider, type SatoKitApprove } from "@satohub/kit/agentkit";
import type { PreparedIntent, Refusal, SatoPolicy } from "@satohub/kit";
import type { Kit, Signer } from "@satohub/kit";

/**
 * AgentKit 0.10.4's WalletProvider base class posts an analytics event to
 * https://cca-lite.coinbase.com/amp on every wallet provider it constructs
 * (the wallet address, network id and chain id), with no option to turn it
 * off. This template turns it off here, once, before any wallet provider is
 * built: fixture mode must make no network call, and no mode sends the
 * wallet address anywhere the person did not choose. test/agentkit.test.ts
 * fails if a fixture run reaches the network.
 */
(WalletProvider.prototype as unknown as { trackInitialization: () => void }).trackInitialization = function noAnalytics() {};

/** The kit tool names this template calls, as the kit's surface publishes them. */
export const TOOLS = {
  chainRead: "chain_read",
  swapQuote: "swap_quote",
  swapPrepare: "swap_prepare",
  execute: "execute",
} as const;

export type ToolName = (typeof TOOLS)[keyof typeof TOOLS];

export type Envelope<R = unknown> =
  | { ok: true; tool: string; result: R }
  | { ok: false; tool: string; error: { code: string; message: string; refusals?: Refusal[] }; intent?: PreparedIntent };

/**
 * A wallet provider that knows an address and a network and holds no key.
 * Fixture mode uses it: AgentKit needs a wallet provider to decide which
 * actions apply, and fixture mode must not hold a key. Every signing or
 * sending method throws.
 */
export class AddressOnlyWalletProvider extends WalletProvider {
  readonly #address: string;
  readonly #network: Network;

  constructor(address: string, network: Network) {
    super();
    this.#address = address;
    this.#network = network;
  }
  getAddress(): string {
    return this.#address;
  }
  getNetwork(): Network {
    return this.#network;
  }
  getName(): string {
    return "address_only_wallet_provider";
  }
  async getBalance(): Promise<bigint> {
    throw new Error("the fixture wallet provider has no balance to read");
  }
  async nativeTransfer(): Promise<string> {
    throw new Error("the fixture wallet provider holds no key and cannot send");
  }
}

export const BASE_MAINNET_NETWORK: Network = { protocolFamily: "evm", networkId: "base-mainnet", chainId: "8453" };
export const BASE_SEPOLIA_NETWORK: Network = { protocolFamily: "evm", networkId: "base-sepolia", chainId: "84532" };

/** The members of an AgentKit EVM wallet provider this file uses. */
export type EvmWalletProviderLike = {
  getAddress(): string;
  signTypedData(typedData: unknown): Promise<`0x${string}`>;
  sendTransaction(tx: { to: `0x${string}`; data?: `0x${string}`; value?: bigint }): Promise<`0x${string}`>;
  waitForTransactionReceipt?(hash: `0x${string}`): Promise<unknown>;
};

/**
 * The kit's Signer over an AgentKit wallet provider, so the kit and AgentKit
 * use one wallet. `kind` names where the key lives: "viem-local" for the fork's
 * in-memory throwaway key, "cdp" for the CDP smart wallet.
 */
export function walletProviderSigner(wp: EvmWalletProviderLike, kind: "viem-local" | "cdp"): Signer {
  return {
    kind,
    async address() {
      return wp.getAddress() as `0x${string}`;
    },
    signTypedData: (td) => wp.signTypedData(td),
    async sendTransaction(tx) {
      const hash = await wp.sendTransaction({ to: tx.to as `0x${string}`, data: tx.data as `0x${string}`, value: BigInt(tx.value) });
      return { tx_hash: hash };
    },
  };
}

export type AgentKitRuntime = {
  agentkit: AgentKit;
  actions: Action[];
  call<R = unknown>(name: ToolName, args: unknown): Promise<Envelope<R>>;
};

/**
 * Builds AgentKit with the Sato Kit's action provider. `approve` is passed only
 * on testnet with --execute; without it the provider refuses execute.
 */
export async function buildAgentKit(opts: {
  kit: Kit;
  walletProvider: WalletProvider;
  policy: SatoPolicy;
  signerKind: string | null;
  approve?: SatoKitApprove;
}): Promise<AgentKitRuntime> {
  const provider = satoKitActionProvider(opts.kit, {
    policy: opts.policy,
    signerKind: opts.signerKind,
    ...(opts.approve ? { approve: opts.approve } : {}),
  });
  const agentkit = await AgentKit.from({ walletProvider: opts.walletProvider, actionProviders: [provider] });
  const actions = agentkit.getActions();
  const byName = new Map(actions.map((a) => [a.name, a]));
  for (const name of Object.values(TOOLS)) {
    if (!byName.has(name)) throw new Error(`AgentKit has no "${name}" action on network ${opts.walletProvider.getNetwork().networkId}`);
  }
  return {
    agentkit,
    actions,
    async call<R>(name: ToolName, args: unknown): Promise<Envelope<R>> {
      const action = byName.get(name)!;
      return JSON.parse(await action.invoke(args as never)) as Envelope<R>;
    },
  };
}

/** The result of an ok envelope, or a thrown error naming the tool and its code. */
export function unwrap<R>(env: Envelope<R>): R {
  if (env.ok) return env.result;
  throw new Error(`${env.tool} failed (${env.error.code}): ${env.error.message}`);
}

/** The prepared intent in a swap_prepare envelope: in the result when it passed, next to the error when the pre-flight refused it. */
export function preparedFrom(env: Envelope<PreparedIntent>): PreparedIntent {
  if (env.ok) return env.result;
  if (env.error.code === "policy_refused" && env.intent) return env.intent;
  throw new Error(`${env.tool} failed (${env.error.code}): ${env.error.message}`);
}
