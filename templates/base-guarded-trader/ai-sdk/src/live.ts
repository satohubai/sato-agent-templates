// --model live: one real run through the Vercel AI SDK.
//
// The model is named by a provider string, e.g. --model-id openai/gpt-5, and
// reached through the AI SDK's default provider (the Vercel AI Gateway), which
// reads AI_GATEWAY_API_KEY. The agent gets the kit's tools and nothing else.
// Reads and quotes run as the model asks; every tool the kit marks as needing
// a person (swap_prepare, x402_prepare, execute) carries the AI SDK approval
// flag, so generateText stops with a tool-approval-request and
// terminalApprover below asks YOU. With no terminal, the answer is no.
//
// Never run by the tests or the fixture command.

import { createInterface } from "node:readline/promises";
import type { AgentConfig } from "./config.js";
import { runAgent, type AgentRun, type Approver, type Host } from "./host.js";
import type { MarketView } from "./model.js";

export function livePrompt(market: MarketView, cfg: AgentConfig, inputs: { own: Record<string, unknown>; overCap: Record<string, unknown> }): string {
  return [
    `Market read at block ${market.block} on Base: gas ${market.gas_price_gwei} gwei, ETH/USD ${market.eth_usd ?? "unknown"}.`,
    `Do exactly this:`,
    `1. swap_quote with ${JSON.stringify(inputs.own)} and report each quote with its fee disclosure verbatim, unranked.`,
    `2. swap_prepare with the same input and report the intent's summary, simulation and pre-flight result.`,
    `3. swap_prepare with ${JSON.stringify(inputs.overCap)} (${cfg.over_cap_amount_usdc} USDC, over the cap on purpose) and report every refusal as rule, limit and observed value.`,
    `4. Only if step 2 passed the pre-flight, you may ask to execute it with { intent_id } and nothing else; a person approves or declines.`,
  ].join("\n");
}

/** Asks the person at the terminal. No terminal: declined. */
export function terminalApprover(): Approver {
  return async (tool, args) => {
    if (!process.stdin.isTTY) return { approved: false, by: "no terminal", reason: "no terminal to ask; declined" };
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const a = (await rl.question(`\nApprove ${tool} with ${JSON.stringify(args)}? [y/N] `)).trim().toLowerCase();
      return a === "y" || a === "yes" ? { approved: true, by: "the person at the terminal", reason: "approved" } : { approved: false, by: "the person at the terminal", reason: "declined" };
    } finally {
      rl.close();
    }
  };
}

/** The environment variable the AI SDK's default provider (the Vercel AI Gateway) reads. */
export const LIVE_KEY_ENV = "AI_GATEWAY_API_KEY";

/** A provider string the gateway resolves: "<provider>/<model>". */
const PROVIDER_STRING_RE = /^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** The model a live run passes to generateText: the provider string itself. */
export function liveModel(modelId: string | null): string {
  if (!modelId || !PROVIDER_STRING_RE.test(modelId)) throw new Error("--model live needs --model-id <provider>/<model>, e.g. --model-id openai/gpt-5");
  return modelId;
}

export async function runLive(host: Host, modelId: string | null, prompt: string, approve: Approver = terminalApprover()): Promise<AgentRun> {
  const model = liveModel(modelId);
  if (!process.env[LIVE_KEY_ENV]) throw new Error(`--model live needs ${LIVE_KEY_ENV} (see .env.example). The default --model scripted needs no key.`);
  const run = await runAgent(host, model, prompt, approve);
  if (run.final_output) console.log(`\n${run.final_output}`);
  return run;
}
