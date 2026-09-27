// The decision step. A Model looks at a market snapshot, proposes trade ideas,
// and turns each idea into AgentKit tool calls by name. It never touches a
// key, a quote or a transaction itself. Swap the MockModel for an LLM-backed
// one (for example AgentKit's LangChain or Vercel AI SDK extension over the
// same actions) by implementing the same interface — every call still goes
// through the kit's quote, prepare, simulation and pre-flight, and execute
// still needs the provider's approve callback.

import type { AgentConfig } from "./config.js";
import type { TokenSymbol } from "./tokens.js";
import { TOOLS, type ToolName } from "./agentkit.js";
import type { SwapInput } from "./kit-io.js";

/** One AgentKit action call: the action's name and its arguments. */
export type ToolCall = { name: ToolName; args: unknown };

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
  /** The AgentKit actions to call for one idea, in order. Never includes execute. */
  toolCalls(idea: TradeIdea, swap: SwapInput): ToolCall[];
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

  /** Always the same two calls: quote (Sato Swap labelled, a no-Sato-fee quote alongside), then prepare. */
  toolCalls(_idea: TradeIdea, swap: SwapInput): ToolCall[] {
    return [
      { name: TOOLS.swapQuote, args: swap },
      { name: TOOLS.swapPrepare, args: swap },
    ];
  }
}
