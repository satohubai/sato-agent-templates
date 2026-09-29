// The decision step. A Model looks at a market snapshot and proposes trade
// ideas; it never touches a key, a quote or a transaction. Swap the MockModel
// for an LLM-backed one by implementing the same interface — every idea it
// returns still goes through the kit's quote, prepare, simulation and
// pre-flight before anything could be signed.

import type { AgentConfig } from "./config.js";
import type { TokenSymbol } from "./tokens.js";

export type MarketView = {
  block: string;
  gas_price_gwei: string;
  /** null when the feed could not be read. */
  eth_usd: number | null;
};

export type TradeIdea = {
  label: string;
  token_in: TokenSymbol;
  token_out: TokenSymbol;
  /** Human units of token_in, as a decimal string. */
  amount: string;
  reason: string;
  /** true for the demo intent that exists to show a refusal. */
  demo_refusal: boolean;
};

export interface Model {
  readonly name: string;
  decide(market: MarketView, config: AgentConfig): TradeIdea[];
}

/** Deterministic: the same market and config always give the same ideas. No network, no randomness. */
export class MockModel implements Model {
  readonly name = "mock-model/1";

  decide(market: MarketView, config: AgentConfig): TradeIdea[] {
    if (market.eth_usd === null) return [];
    return [
      {
        label: `buy WETH with ${config.amount_usdc} USDC`,
        token_in: "USDC",
        token_out: "WETH",
        amount: config.amount_usdc,
        reason: `ETH/USD read at ${market.eth_usd.toFixed(2)} on block ${market.block}; the mock model always proposes the configured size.`,
        demo_refusal: false,
      },
      {
        label: `buy WETH with ${config.over_cap_amount_usdc} USDC (over the cap on purpose)`,
        token_in: "USDC",
        token_out: "WETH",
        amount: config.over_cap_amount_usdc,
        reason: "A deliberately oversized intent, so every run shows the pre-flight refusing with its rule, limit and observed value.",
        demo_refusal: true,
      },
    ];
  }
}

// ── The scripted turns for the Vercel AI SDK host ───────────────────────────
//
// In fixture mode no model API is called. The MockModel's ideas become a fixed
// list of tool calls that host.ts's scripted mock model (ai/test) hands to
// generateText, in the order a model would make them: quote, prepare, and finally
// one execute request for an intent that passed the pre-flight, which
// generateText stops for approval (fixture mode has no signer and no person to
// approve it).

export type ScriptedTurn = { tool: string; args: Record<string, unknown>; note: string; idea?: number };

type Seen = ReadonlyArray<{ turn: { tool: string; idea?: number }; envelope: { ok: boolean; result?: unknown } | null }>;

export const SCRIPTED_MODEL_NAME = "scripted-turns/1";

/**
 * Returns the next turn given what has happened so far, or null when done.
 * Deterministic: the same ideas and results always give the same turns.
 */
export function scriptedNext(ideas: readonly TradeIdea[], inputFor: (idea: TradeIdea) => Record<string, unknown>) {
  const plan: ScriptedTurn[] = [];
  ideas.forEach((idea, i) => {
    plan.push({ tool: "swap_quote", args: inputFor(idea), note: `quote: ${idea.label}`, idea: i });
    plan.push({ tool: "swap_prepare", args: inputFor(idea), note: `prepare: ${idea.label}`, idea: i });
  });
  return (seen: Seen): ScriptedTurn | null => {
    if (seen.length < plan.length) return plan[seen.length];
    if (seen.length > plan.length) return null;
    const passed = seen.find((d) => d.turn.tool === "swap_prepare" && d.turn.idea !== undefined && !ideas[d.turn.idea].demo_refusal && d.envelope?.ok);
    const id = (passed?.envelope?.result as { intent_id?: string } | undefined)?.intent_id;
    return id ? { tool: "execute", args: { intent_id: id }, note: "ask to execute the intent that passed the pre-flight" } : null;
  };
}
