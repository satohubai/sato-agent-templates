// The ONE place this template names kit action ids and their input shapes.
//
// They mirror the input_schema each action's descriptor publishes
// (`kit.describe(id).input_schema`) in @satohub/kit 0.1.1. The kit validates
// every input itself; if a shape here drifts, the kit's ActionInputError says
// which field. Fix it here and nowhere else.

import type { SolanaCluster } from "@satohub/kit";

export const ACTIONS = {
  solanaRead: "solana.read",
  swapQuote: "solana.swap.quote",
  swapPrepare: "solana.swap.prepare",
} as const;

export const CHAIN: SolanaCluster = "solana";

/** solana.read, kind sol_balance. `amount` is lamports as a decimal string, null when the account does not exist. */
export type SolBalanceInput = { chain: SolanaCluster; kind: "sol_balance"; address: string };
export type SolBalanceOutput = { kind: string; chain: string; address: string; amount: string | null; decimals: number | null; slot: number | null; as_of: string };

/** The kit's venue names for Solana. "sato" is the labelled default; "direct" asks Jupiter only and does not contact Sato. */
export type SolanaVenue = "sato" | "direct";

/** solana.swap.quote and solana.swap.prepare share this input (prepare requires taker). */
export type SwapInput = {
  chain: SolanaCluster;
  input_mint: string;
  output_mint: string;
  /** Base units of the input mint, decimal string. */
  amount: string;
  taker?: string;
  slippage_bps: number;
  venue: SolanaVenue;
};

export type SolanaQuote = {
  venue: "sato" | "jupiter";
  chain: string;
  input_mint: string;
  output_mint: string;
  amount: string;
  out_amount: string | null;
  out_amount_min: string | null;
  route_via: string | null;
  sato_fee_bps: number | null;
  sato_fee_recipient: string | null;
  fee_disclosure: string;
  upstream_fees: unknown;
  swap_usd: number | null;
  error: string | null;
  as_of: string;
};

export type SwapQuoteOutput = { quotes: SolanaQuote[]; order: "as_requested"; note: string; as_of: string };

export function venueLabel(venue: string): string {
  if (venue === "sato") return "Sato Route (labelled default)";
  if (venue === "jupiter") return "Jupiter (no Sato fee)";
  return venue;
}
