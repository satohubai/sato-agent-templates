// USD facts for the pre-flight's USD caps.
//
// The kit's swap.prepare passes the venue's own USD value of the sell side
// when the venue returns one (LI.FI does); the Sato Swap response carries
// none, and the kit leaves "USD already spent today" to the host. With
// unknown_verdict "refuse", an unknown value refuses every trade, which is the
// intended default when a price really is unknown.
//
// This wrapper fills ONLY facts the kit left null, from sources this template
// names, then hands them to the kit's own evaluatePreflight unchanged:
//   - USDC is counted at 1.00 USD (a stated assumption, not a price read);
//   - WETH is valued with the Chainlink ETH/USD answer the agent read;
//   - "spent today" is the USD this process has executed today (fixture and
//     fork runs never execute, so it is 0 there). It does not survive a
//     restart; a managed wallet's own policy is what enforces a daily limit.
// Any other token keeps usd_value null, so unknown_verdict decides.

import { evaluatePreflight, type EvaluatePreflight, type PreflightFacts } from "@satohub/kit";
import { formatUnits } from "viem";
import { TOKENS, type ChainName } from "./tokens.js";

export type UsdSource = { eth_usd: number | null };

export class SpendLedger {
  private day = "";
  private total = 0;
  constructor(private readonly clock: () => number) {}
  private roll() {
    const d = new Date(this.clock()).toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.total = 0;
    }
  }
  spentToday(): number {
    this.roll();
    return this.total;
  }
  add(usd: number): void {
    this.roll();
    this.total += usd;
  }
}

/** USD value of `amount` base units of `token` on `chain`, or null when this template has no source for it. */
export function usdValue(chain: string, token: string | undefined, amount: string | undefined, src: UsdSource): number | null {
  if (!token || !amount || !/^[0-9]+$/.test(amount)) return null;
  const t = TOKENS[chain as ChainName];
  if (!t) return null;
  const lower = token.toLowerCase();
  if (lower === t.USDC.address.toLowerCase()) return Number(formatUnits(BigInt(amount), t.USDC.decimals));
  if (lower === t.WETH.address.toLowerCase() && src.eth_usd !== null) return Number(formatUnits(BigInt(amount), t.WETH.decimals)) * src.eth_usd;
  return null;
}

export function pricedPreflight(src: () => UsdSource, ledger: SpendLedger): EvaluatePreflight {
  return (policy, facts: PreflightFacts) =>
    evaluatePreflight(policy, {
      ...facts,
      usd_value: facts.usd_value ?? usdValue(facts.chain, facts.token, facts.token_amount_base_units, src()),
      usd_spent_today: facts.usd_spent_today ?? ledger.spentToday(),
    });
}
