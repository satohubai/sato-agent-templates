// The ONE place this template names kit action ids and their input shapes.
//
// These mirror the input_schema each action's descriptor publishes
// (`kit.describe(id).input_schema`) in @satohub/kit 0.1.0. The kit validates
// every input itself; if a shape here drifts, the kit's ActionInputError says
// which field. Fix it here and nowhere else.

import type { SwapQuote } from "@satohub/kit";
import type { AbiFunction } from "viem";
import type { ChainName } from "./tokens.js";

export const ACTIONS = {
  chainRead: "chain.read",
  swapQuote: "swap.quote",
  swapPrepare: "swap.prepare",
  txSimulate: "tx.simulate",
} as const;

/** chain.read, kind contract_read: one view/pure fragment, read at the RPC's latest block. */
export type ChainReadInput = {
  kind: "contract_read";
  chain: ChainName;
  contract: string;
  abi: AbiFunction;
  /** Integers as decimal strings. */
  args?: unknown[];
};

/** chain.read output: `result` has bigints as decimal strings. */
export type ChainReadOutput<R = unknown> = {
  kind: string;
  chain: string;
  block_number: string;
  result: R;
  as_of: string;
};

/** The kit's venue names. This template offers "sato" and "direct" in config.json. */
export type KitSwapVenue = "sato" | "direct" | "lifi" | "0x";

/** swap.quote and swap.prepare share this input (prepare requires taker). */
export type SwapInput = {
  chain: ChainName;
  sell_token: string;
  buy_token: string;
  /** Base units, decimal string. */
  sell_amount: string;
  taker?: string;
  slippage_bps: number;
  /**
   * "sato" = Sato Swap, the labelled default; its fee sentence is quoted
   * verbatim and a quote with no Sato fee (LI.FI) is returned alongside.
   * "direct" = the no-Sato-fee quote only; Sato is not contacted.
   */
  venue: KitSwapVenue;
};

export type SwapQuoteOutput = {
  quotes: SwapQuote[];
  order: "as_requested";
  note: string;
  as_of: string;
};

/** Pick one function fragment out of an ABI, for chain.read. */
export function fragment(abi: readonly unknown[], name: string): AbiFunction {
  const f = abi.find((x) => (x as { type?: string; name?: string }).type === "function" && (x as { name?: string }).name === name);
  if (!f) throw new Error(`no function ${name} in the ABI`);
  return f as AbiFunction;
}

/** A human label per venue. Order is the kit's request order; nothing is ranked. */
export function venueLabel(venue: string): string {
  if (venue === "sato") return "Sato Swap (labelled default)";
  if (venue === "lifi") return "LI.FI (no Sato fee)";
  if (venue === "0x") return "0x (no Sato fee)";
  return venue;
}
