// The ONE place this template names kit action ids and their input shapes.
// They mirror the input_schema chain.read publishes in @satohub/kit 0.1.0
// (`kit.describe("chain.read").input_schema`). The kit validates every input
// itself; if a shape drifts, its ActionInputError names the field.

import type { AbiFunction } from "viem";

export const ACTIONS = {
  chainRead: "chain.read",
} as const;

export type ChainName = "base" | "base-sepolia";

export type ChainReadInput =
  | { kind: "block_number"; chain: ChainName }
  | { kind: "native_balance"; chain: ChainName; address: string }
  | { kind: "erc20_balance"; chain: ChainName; token: string; owner: string }
  | { kind: "contract_read"; chain: ChainName; contract: string; abi: AbiFunction; args?: unknown[] };

/** chain.read output: `result` has bigints as decimal strings. */
export type ChainReadOutput<R = unknown> = {
  kind: string;
  chain: string;
  block_number: string;
  result: R;
  as_of: string;
};

/** ERC-20 totalSupply(), for a `erc20_total_supply` read (a contract_read under the hood). */
export const TOTAL_SUPPLY_FRAGMENT: AbiFunction = {
  type: "function",
  name: "totalSupply",
  inputs: [],
  outputs: [{ name: "", type: "uint256" }],
  stateMutability: "view",
};
