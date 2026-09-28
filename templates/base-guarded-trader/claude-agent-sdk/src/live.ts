// --model claude: one real query() through the Claude Agent SDK.
//
// The model gets the kit's in-process server and nothing else (no built-in
// tools). Reads and quotes are pre-allowed; every tool the kit marks as
// needing a person (swap_prepare, x402_prepare, execute) goes through the
// requireApprovalHook, which answers "ask", and canUseTool below asks YOU on
// the terminal. With no terminal, the answer is no.
//
// Needs ANTHROPIC_API_KEY. Never run by the tests or the fixture command.

import { createInterface } from "node:readline/promises";
import { query, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "./config.js";
import { HOOK_MATCHER, hostToolName, READ_TOOLS, SERVER_NAME, type Host } from "./host.js";
import type { MarketView } from "./model.js";

export function livePrompt(market: MarketView, cfg: AgentConfig, inputs: { own: Record<string, unknown>; overCap: Record<string, unknown> }): string {
  return [
    `You run a guarded trading pass on Base. Market read at block ${market.block}: gas ${market.gas_price_gwei} gwei, ETH/USD ${market.eth_usd ?? "unknown"}.`,
    `Use only the ${SERVER_NAME} tools. Do exactly this:`,
    `1. swap_quote with ${JSON.stringify(inputs.own)} and report each quote with its fee disclosure verbatim, unranked.`,
    `2. swap_prepare with the same input and report the intent's summary, simulation and pre-flight result.`,
    `3. swap_prepare with ${JSON.stringify(inputs.overCap)} (${cfg.over_cap_amount_usdc} USDC, over the cap on purpose) and report every refusal as rule, limit and observed value.`,
    `4. Only if step 2 passed the pre-flight, you may ask to execute it with { intent_id } and nothing else; a person approves or declines.`,
    `Make no claim about outcomes, profit or risk.`,
  ].join("\n");
}

/** Asks the person at the terminal. No terminal: declined. */
export function terminalApproval(): CanUseTool {
  return async (toolName, input) => {
    if (!process.stdin.isTTY) return { behavior: "deny", message: "no terminal to ask; declined" };
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const a = (await rl.question(`\nApprove ${toolName} with ${JSON.stringify(input)}? [y/N] `)).trim().toLowerCase();
      return a === "y" || a === "yes" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "declined by the person at the terminal" };
    } finally {
      rl.close();
    }
  };
}

/** The options a live run passes to query(); exported so a test can check the wiring without starting anything. */
export function liveOptions(host: Host, modelId: string, canUseTool: CanUseTool) {
  return {
    model: modelId,
    tools: [] as string[],
    mcpServers: { [SERVER_NAME]: host.server },
    allowedTools: READ_TOOLS.map(hostToolName),
    hooks: { PreToolUse: [{ matcher: HOOK_MATCHER, hooks: [host.hook] }] },
    canUseTool,
    maxTurns: 12,
  };
}

export async function runLive(host: Host, modelId: string, prompt: string): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("--model claude needs ANTHROPIC_API_KEY (see .env.example). The default --model scripted needs no key.");
  for await (const msg of query({ prompt, options: liveOptions(host, modelId, terminalApproval()) })) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) if (block.type === "text") console.log(block.text);
    } else if (msg.type === "result") {
      console.log(`\nquery finished: ${msg.subtype}`);
    }
  }
}
