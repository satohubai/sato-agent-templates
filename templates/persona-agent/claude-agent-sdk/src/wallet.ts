// The persona's wallet: every call goes through the Sato Kit.
//   quote    swap.quote, read-only
//   prepare  swap.prepare: an unsigned intent + simulation + the policy
//            pre-flight, which names the rule, limit and observed value of
//            every refusal
//   execute  never offered to the model. The agent loop calls it only on
//            testnet, with --allow-execute, and the signer asks a person first.

import type { PreparedIntent, Refusal } from "@satohub/kit";
import { parseUnits } from "viem";
import { ACTIONS, type SwapInput, type SwapQuoteOutput } from "./kit-io.js";
import type { AgentConfig } from "./config.js";
import type { Runtime } from "./runtime.js";
import { TOKENS, type TokenSymbol } from "./tokens.js";

export type WalletRequest = { kind: "quote" | "prepare"; token_in: TokenSymbol; token_out: TokenSymbol; amount: string };

export type WalletResult = {
  request: WalletRequest;
  quotes?: { venue: string; buy_amount: string | null; fee_disclosure: string; error?: string }[];
  intent_id?: string;
  summary?: string;
  policy_ok?: boolean;
  refusals?: Refusal[];
  simulation?: PreparedIntent["simulation"];
};

export function refusalLine(r: Refusal): string {
  return `REFUSED rule=${r.rule} limit=${r.limit} observed=${r.observed} — ${r.message}`;
}

export class Wallet {
  readonly prepared = new Map<string, PreparedIntent>();
  constructor(private readonly rt: Runtime, private readonly cfg: AgentConfig) {}

  private input(req: WalletRequest): SwapInput {
    const tin = TOKENS[this.rt.chain][req.token_in];
    const tout = TOKENS[this.rt.chain][req.token_out];
    if (!tin || !tout) throw new Error(`unknown token pair ${req.token_in}/${req.token_out}`);
    return { chain: this.rt.chain, sell_token: tin.address, buy_token: tout.address, sell_amount: parseUnits(req.amount, tin.decimals).toString(), slippage_bps: this.cfg.slippage_bps, venue: this.cfg.venue, taker: this.rt.taker };
  }

  async run(req: WalletRequest): Promise<WalletResult> {
    const input = this.input(req);
    if (req.kind === "quote") {
      const q = await this.rt.kit.read<SwapQuoteOutput>(ACTIONS.swapQuote, input);
      return { request: req, quotes: q.quotes.map((x) => ({ venue: x.venue, buy_amount: x.buy_amount ?? null, fee_disclosure: x.fee_disclosure, ...(x.error ? { error: x.error } : {}) })) };
    }
    const p = await this.rt.kit.prepare(ACTIONS.swapPrepare, input);
    this.prepared.set(p.intent_id, p);
    return { request: req, intent_id: p.intent_id, summary: p.summary, policy_ok: p.policy.ok, refusals: p.policy.refusals, simulation: p.simulation };
  }

  /** Testnet only, after --allow-execute; the signer still asks a person. */
  async execute(intentId: string, allowExecute: boolean) {
    if (this.rt.mode !== "testnet" || !allowExecute) throw new Error("execute is available on testnet with --allow-execute only");
    const p = this.prepared.get(intentId);
    if (!p || !p.policy.ok) throw new Error("execute needs an intent this run prepared and the pre-flight passed");
    return this.rt.kit.execute({ intent_id: intentId });
  }
}
