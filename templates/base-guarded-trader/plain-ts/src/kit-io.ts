// The ONE place this template names kit action ids and their input shapes.
//
// @satohub/kit 0.1.0 is a preview: its types (createKit, Kit, PreparedIntent,
// Receipt, Signer) are final, but each action's input schema is published by
// the action's own descriptor (`kit.describe(id).input_schema`). If a shape
// here drifts from the descriptor, the kit's input validation says so; fix it
// here and nowhere else.

import type { FeeDisclosure } from "@satohub/kit";
import type { Abi } from "viem";
import type { ChainName } from "./tokens.js";

export const ACTIONS = {
  chainRead: "chain.read",
  swapQuote: "swap.quote",
  swapPrepare: "swap.prepare",
  txSimulate: "tx.simulate",
} as const;

export type ChainReadInput = {
  chain: ChainName;
  address: string;
  abi: Abi;
  function_name: string;
  args?: unknown[];
  /** Decimal block number; omitted = latest. */
  block?: string;
};

export type SwapInput = {
  chain: ChainName;
  token_in: string;
  token_out: string;
  amount_in_base_units: string;
  slippage_bps: number;
  /** "sato" = Sato Swap (labelled default, fee disclosed, no-Sato-fee quote alongside). "direct" = no Sato call at all. */
  venue: "sato" | "direct";
  /** swap.prepare only: the address the transaction is built for. */
  taker?: string;
};

export type QuoteLine = {
  venue: string;
  amount_out_base_units: string;
  fee_disclosure: FeeDisclosure | null;
  label?: string;
};

/** Tolerant reader: the quote output is shown to a person, never trusted for a decision. */
export function readQuotes(out: unknown): QuoteLine[] {
  const o = (out ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(o.quotes) ? o.quotes : Array.isArray(out) ? (out as unknown[]) : [o];
  return raw
    .filter((q): q is Record<string, unknown> => typeof q === "object" && q !== null)
    .map((q) => ({
      venue: String(q.venue ?? "unknown"),
      amount_out_base_units: String(q.amount_out_base_units ?? q.amount_out ?? "unknown"),
      fee_disclosure: (q.fee_disclosure as FeeDisclosure | null | undefined) ?? null,
      label: typeof q.label === "string" ? q.label : undefined,
    }));
}
