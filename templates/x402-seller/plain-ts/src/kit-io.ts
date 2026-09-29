// The ONE place this template names kit action ids and their input shapes.
// They mirror the input_schema chain.read publishes in @satohub/kit 0.1.0
// (`kit.describe("chain.read").input_schema`). The kit validates every input
// itself; if a shape drifts, its ActionInputError names the field.

export const ACTIONS = {
  chainRead: "chain.read",
} as const;

export type ChainName = "base" | "base-sepolia";

export type ChainReadInput =
  | { kind: "erc20_balance"; chain: ChainName; token: string; owner: string }
  | { kind: "contract_read"; chain: ChainName; contract: string; abi: unknown; args: unknown[] };

/** chain.read output: `result` has bigints as decimal strings. */
export type ChainReadOutput<R = unknown> = {
  kind: string;
  chain: string;
  block_number: string;
  result: R;
  as_of: string;
};

/** ERC-3009 authorizationState(authorizer, nonce): true once the authorization was used. */
export const AUTHORIZATION_STATE_FRAGMENT = {
  type: "function",
  name: "authorizationState",
  stateMutability: "view",
  inputs: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }],
  outputs: [{ name: "", type: "bool" }],
} as const;
