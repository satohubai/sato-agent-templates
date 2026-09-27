// Live mode: the Claude Agent SDK runs the loop. The persona's system prompt
// comes from character.json plus retrieved memories; the only tools are
// wallet_quote and wallet_prepare, served in-process. Built-in tools (shell,
// files, web) are disabled. No tool here can sign or send.
//
// Needs ANTHROPIC_API_KEY. Loaded lazily, so fixture mode never imports it.

import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { systemPrompt } from "./character.js";
import type { Model, ModelReply, Turn } from "./model.js";
import type { WalletResult } from "./wallet.js";

export const DEFAULT_MODEL = "claude-opus-5-5";

export class ClaudeModel implements Model {
  readonly name: string;
  constructor(private readonly model: string = DEFAULT_MODEL, private readonly maxTurns = 6) {
    this.name = `claude-agent-sdk/${model}`;
  }

  async respond(t: Turn): Promise<ModelReply> {
    const calls: WalletResult[] = [];
    const shape = { token_in: z.enum(["USDC", "WETH"]), token_out: z.enum(["USDC", "WETH"]), amount: z.string().regex(/^[0-9]+(\.[0-9]+)?$/) };
    const asText = (r: WalletResult) => ({ content: [{ type: "text" as const, text: JSON.stringify(r) }] });
    const server = createSdkMcpServer({
      name: "wallet",
      version: "0.1.0",
      tools: [
        tool("wallet_quote", "Quote a swap on Base through the Sato Kit. Read-only; returns each venue's quote and its fee sentence verbatim.", shape, async (a) => {
          const r = await t.wallet({ kind: "quote", ...a });
          calls.push(r);
          return asText(r);
        }),
        tool("wallet_prepare", "Prepare an unsigned swap intent and run the policy pre-flight. Returns policy_ok and, when refused, each rule, limit and observed value. Does not sign or send.", shape, async (a) => {
          const r = await t.wallet({ kind: "prepare", ...a });
          calls.push(r);
          return asText(r);
        }),
      ],
    });
    const memories = t.memories.map((m) => `${m.user} (${m.at.slice(0, 10)}): ${m.text}`);
    let reply = "";
    for await (const msg of query({
      prompt: `${t.message.user} on ${t.message.connector}: ${t.message.text}`,
      options: {
        model: this.model,
        systemPrompt: systemPrompt(t.character, memories),
        tools: [],
        mcpServers: { wallet: server },
        allowedTools: ["mcp__wallet__wallet_quote", "mcp__wallet__wallet_prepare"],
        maxTurns: this.maxTurns,
        settingSources: [],
      },
    })) {
      if (msg.type === "result") reply = msg.subtype === "success" ? msg.result : `I couldn't answer that (${msg.subtype}).`;
    }
    return { reply: reply.trim() || "I don't know.", wallet: calls };
  }
}
