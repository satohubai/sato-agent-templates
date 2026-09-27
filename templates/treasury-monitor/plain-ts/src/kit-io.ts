// The ONE place this template names kit action ids and their input shapes.
// They mirror the input_schema chain.read publishes in @satohub/kit 0.1.0
// (`kit.describe("chain.read").input_schema`). The kit validates every input
// itself; if a shape drifts, its ActionInputError names the field.

export const ACTIONS = {
  chainRead: "chain.read",
} as const;

export type ChainName = "base" | "base-sepolia";

/** EVM chain id -> the kit's chain name, for the chains this template reads. */
export const CHAIN_BY_ID: Record<number, ChainName> = { 8453: "base", 84532: "base-sepolia" };

export type ChainReadInput =
  | { kind: "native_balance"; chain: ChainName; address: string }
  | { kind: "erc20_balance"; chain: ChainName; token: string; owner: string };

/** chain.read output: `result` has bigints as decimal strings. */
export type ChainReadOutput<R = unknown> = {
  kind: string;
  chain: string;
  block_number: string;
  result: R;
  as_of: string;
};
