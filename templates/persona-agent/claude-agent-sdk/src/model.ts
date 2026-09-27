// The decision step. A Model reads the character, the retrieved memories and
// one inbound message, may call the wallet tool (quote or prepare only), and
// returns a reply. It never sees a key and has no execute tool.
//
//   ScriptedModel  fixture mode: deterministic rules, no network, no key.
//   ClaudeModel    live mode: the Claude Agent SDK loop (src/claude.ts).

import type { Character } from "./character.js";
import type { MemoryEntry } from "./memory.js";
import type { Inbound } from "./connectors/types.js";
import { refusalLine, type WalletRequest, type WalletResult } from "./wallet.js";
import type { TokenSymbol } from "./tokens.js";

export type WalletTool = (req: WalletRequest) => Promise<WalletResult>;

export type Turn = { character: Character; memories: MemoryEntry[]; message: Inbound; wallet: WalletTool };

export type ModelReply = { reply: string; wallet: WalletResult[] };

export interface Model {
  readonly name: string;
  respond(turn: Turn): Promise<ModelReply>;
}

const TOKEN = "(USDC|WETH)";
const QUOTE = new RegExp(`\\bquote\\s+([0-9]+(?:\\.[0-9]+)?)\\s+${TOKEN}\\s+(?:to|for|into)\\s+${TOKEN}`, "i");
const SWAP = new RegExp(`\\b(?:swap|buy|sell)\\s+([0-9]+(?:\\.[0-9]+)?)\\s+${TOKEN}\\s+(?:to|for|into|of)\\s+${TOKEN}`, "i");

function sym(s: string): TokenSymbol {
  return s.toUpperCase() as TokenSymbol;
}

/** Deterministic: the same turn always gives the same reply. */
export class ScriptedModel implements Model {
  readonly name = "scripted-model/1";

  async respond(t: Turn): Promise<ModelReply> {
    const text = t.message.text;
    const q = text.match(QUOTE);
    if (q) {
      const r = await t.wallet({ kind: "quote", amount: q[1], token_in: sym(q[2]), token_out: sym(q[3]) });
      const lines = (r.quotes ?? []).map((x) => `${x.venue}: ${x.buy_amount ?? "no quote"} base units of ${sym(q[3])}. Fee, verbatim: ${x.fee_disclosure}`);
      return { reply: [`Quotes for ${q[1]} ${sym(q[2])} to ${sym(q[3])}, in the order requested, nothing ranked:`, ...lines, "A quote is not a trade."].join("\n"), wallet: [r] };
    }
    const s = text.match(SWAP);
    if (s) {
      const r = await t.wallet({ kind: "prepare", amount: s[1], token_in: sym(s[2]), token_out: sym(s[3]) });
      if (r.policy_ok) return { reply: `I prepared an unsigned intent (${r.intent_id}). It passed the pre-flight. Signing needs a person to approve it.`, wallet: [r] };
      return { reply: [`I can't prepare that one. The pre-flight refused it:`, ...(r.refusals ?? []).map(refusalLine), "Nothing was signed or sent."].join("\n"), wallet: [r] };
    }
    const lower = text.toLowerCase();
    if (/\bgm\b/.test(lower)) return { reply: `gm ${t.message.user}. What are you building today?`, wallet: [] };
    if (/remember/.test(lower)) {
      if (!t.memories.length) return { reply: "I don't remember anything about that yet.", wallet: [] };
      return { reply: `Here is what I have: ${t.memories.map((m) => `"${m.text}" (${m.at.slice(0, 10)})`).join("; ")}.`, wallet: [] };
    }
    return { reply: "I don't know. Ask me about agent tooling, Base, or a swap quote.", wallet: [] };
  }
}
