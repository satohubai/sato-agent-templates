// The Vercel AI SDK side of the template, in one place.
//
//   buildHost(rt)        the kit's tools as an AI SDK ToolSet (satoKitTools
//                        from @satohub/kit/ai-sdk). Every tool the kit marks as
//                        needing a person (swap_prepare, x402_prepare, execute)
//                        carries the AI SDK approval flag, so generateText
//                        stops with a tool-approval-request instead of running
//                        it. The model only ever sees the kit's tools; it holds
//                        no key and builds no transaction.
//   runAgent(...)        runs generateText with those tools and answers every
//                        approval request with an Approver (a
//                        tool-approval-response message), until the model
//                        stops. The same loop serves the scripted model
//                        (fixture mode) and a live model (--model live).
//   scriptedModel(...)   fixture mode's "model": the AI SDK's own
//                        MockLanguageModelV4 from `ai/test`, emitting a fixed
//                        list of tool calls. It never calls an API.
//
// Every prepared intent the tools hand out is kept (recordingKit) so the report
// shows exactly what the model saw, whichever model ran.

import { generateText, isStepCount, type LanguageModel, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { satoKitToolApproval, satoKitTools, type SatoKitAiTools } from "@satohub/kit/ai-sdk";
import { CORE_ACTIONS, type Kit, type PreparedIntent } from "@satohub/kit";
import type { Runtime } from "./runtime.js";

export const AGENT_NAME = "base-guarded-trader";

export type Prepared = { input: Record<string, unknown>; intent: PreparedIntent };

/** A kit that remembers every intent it prepared, in order. Nothing else changes. */
export function recordingKit(kit: Kit, sink: Prepared[]): Kit {
  return new Proxy(kit, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return async (id: string, input: Record<string, unknown>) => {
          const intent = await target.prepare(id, input);
          sink.push({ input, intent });
          return intent;
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** A fetch that refuses everything: the `status` tool degrades to "unknown" instead of reaching the network. */
const offlineFetch = (async () => {
  throw new TypeError("offline: this run does not read Sato Status");
}) as unknown as typeof fetch;

export type Host = {
  tools: SatoKitAiTools;
  prepared: Prepared[];
};

export function buildHost(rt: Runtime): Host {
  const prepared: Prepared[] = [];
  const tools = satoKitTools(recordingKit(rt.kit, prepared), {
    policy: rt.policy,
    actions: CORE_ACTIONS.list(),
    signerKind: rt.signer ? rt.signer.kind : null,
    fetch: rt.mode === "fixture" ? offlineFetch : undefined,
  });
  return { tools, prepared };
}

/** The names of the tools that stop for a person's approval, as the kit's adapter marks them. */
export function approvalTools(host: Host): string[] {
  return Object.keys(satoKitToolApproval(host.tools));
}

/** The kit adapter's one result shape. */
export type Envelope =
  | { ok: true; tool: string; result: unknown }
  | { ok: false; tool: string; error: { code: string; message: string; refusals?: unknown[] }; intent?: PreparedIntent };

export type Approval = {
  tool: string;
  /** "approval-requested" when generateText stopped with a tool-approval-request; "none" when the tool needs no person. */
  gate: "approval-requested" | "none";
  approved: boolean;
  by: string;
  reason: string;
};

/** Answers an approval request. In fixture mode it is scripted; nobody is prompted. */
export type Approver = (tool: string, args: Record<string, unknown>) => Promise<{ approved: boolean; by: string; reason: string }>;

export type ToolCall = { call_id: string; tool: string; args: Record<string, unknown>; approval: Approval; envelope: Envelope | null };

function asObject(v: unknown): Record<string, unknown> {
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return {};
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * The envelope a tool returned, from a tool-result part's output (AI SDK
 * `{ type: "json", value }`, or the raw value); null when it is not one (e.g.
 * an `execution-denied` output).
 */
export function envelopeOf(output: unknown): Envelope | null {
  let v: unknown = output;
  if (v && typeof v === "object") {
    const o = v as { type?: string; value?: unknown };
    if (o.type === "json" || o.type === "text") v = o.value;
    else if (typeof o.type === "string" && !("ok" in o)) return null;
  }
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (v && typeof v === "object" && typeof (v as { ok?: unknown }).ok === "boolean" && typeof (v as { tool?: unknown }).tool === "string") return v as Envelope;
  return null;
}

type Part = { type?: string; toolCallId?: string; toolName?: string; input?: unknown; output?: unknown; approvalId?: string };

function partsOf(messages: readonly ModelMessage[], role: string): Part[] {
  const out: Part[] = [];
  for (const m of messages) if (m.role === role && Array.isArray(m.content)) out.push(...(m.content as Part[]));
  return out;
}

/** The tool calls in a finished run's messages, in order, with what came back. */
export function toolCallsOf(messages: readonly ModelMessage[], approvals: ReadonlyMap<string, Approval>): ToolCall[] {
  const results = new Map<string, unknown>();
  for (const p of partsOf(messages, "tool")) if (p.type === "tool-result" && p.toolCallId) results.set(p.toolCallId, p.output);
  const calls: ToolCall[] = [];
  for (const p of partsOf(messages, "assistant")) {
    if (p.type !== "tool-call" || !p.toolCallId || !p.toolName) continue;
    const approval = approvals.get(p.toolCallId) ?? { tool: p.toolName, gate: "none" as const, approved: true, by: "no approval needed", reason: "reads or quotes only" };
    calls.push({ call_id: p.toolCallId, tool: p.toolName, args: asObject(p.input), approval, envelope: approval.approved ? envelopeOf(results.get(p.toolCallId)) : null });
  }
  return calls;
}

export type AgentRun = { calls: ToolCall[]; final_output: string; messages: ModelMessage[] };

export const INSTRUCTIONS = [
  "You run one guarded trading pass on Base with the Sato Kit's tools and nothing else.",
  "Report each swap quote with its fee disclosure verbatim, unranked; Sato Swap is labelled as Sato's.",
  "Report every pre-flight refusal as rule, limit and observed value.",
  "Ask to execute only an intent that passed the pre-flight, with { intent_id } and nothing else; a person approves or declines.",
  "Make no claim about outcomes, profit or risk.",
].join(" ");

/**
 * Runs the agent to completion. Each time generateText stops with approval
 * requests, the approver answers every one (a tool-approval-response in a tool
 * message) and the run continues from the full message history. Telemetry is
 * left off, so nothing is exported to a tracing backend.
 */
export async function runAgent(host: Host, model: LanguageModel, input: string, approve: Approver, maxSteps = 12): Promise<AgentRun> {
  const messages: ModelMessage[] = [{ role: "user", content: input }];
  const approvals = new Map<string, Approval>();
  let text = "";
  for (let rounds = 0; ; rounds++) {
    if (rounds > maxSteps) throw new Error("too many approval rounds; stopping");
    const r = await generateText({ model, system: INSTRUCTIONS, tools: host.tools, messages, stopWhen: isStepCount(maxSteps), maxRetries: 0 });
    messages.push(...(r.responseMessages as ModelMessage[]));
    text = r.text;
    const requests = r.content.filter((c) => c.type === "tool-approval-request");
    if (requests.length === 0) break;
    const responses: Array<{ type: "tool-approval-response"; approvalId: string; approved: boolean; reason: string }> = [];
    for (const req of requests) {
      const call = req.toolCall as { toolCallId: string; toolName: string; input: unknown };
      const a = await approve(call.toolName, asObject(call.input));
      approvals.set(call.toolCallId, { tool: call.toolName, gate: "approval-requested", ...a });
      responses.push({ type: "tool-approval-response", approvalId: req.approvalId, approved: a.approved, reason: a.reason });
    }
    messages.push({ role: "tool", content: responses });
  }
  return { calls: toolCallsOf(messages, approvals), final_output: text, messages };
}

// ── The scripted model ───────────────────────────────────────────────────────
//
// The AI SDK's MockLanguageModelV4 (from `ai/test`), made to answer from a
// script. Each doGenerate returns the next tool call from `next`, which sees
// the envelopes returned so far (parsed from the prompt's own tool results,
// exactly what a real model would read), or a final text when `next` returns
// null. Deterministic: the same results always give the same calls.

export type Turn = { tool: string; args: Record<string, unknown>; note: string; idea?: number };
export type Seen = { turn: Turn; envelope: Envelope | null };

const NO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

export const SCRIPTED_DONE = "Done: every call above was made by a fixed script; no model API was called.";

export function scriptedModel(next: (seen: readonly Seen[]) => Turn | null, name = "scripted-turns/1", onTurn: (t: Turn) => void = () => {}): MockLanguageModelV4 {
  const issued: Turn[] = [];
  return new MockLanguageModelV4({
    provider: "scripted",
    modelId: name,
    doGenerate: async (options) => {
      const results = new Map<string, unknown>();
      for (const m of options.prompt) {
        if (m.role !== "tool") continue;
        for (const p of m.content as Part[]) if (p.type === "tool-result" && p.toolCallId) results.set(p.toolCallId, p.output);
      }
      const seen: Seen[] = issued.map((turn, n) => ({ turn, envelope: results.has(callId(n)) ? envelopeOf(results.get(callId(n))) : null }));
      const turn = next(seen);
      if (!turn) {
        return { content: [{ type: "text", text: SCRIPTED_DONE }], finishReason: { unified: "stop", raw: undefined }, usage: NO_USAGE, warnings: [] };
      }
      const n = issued.length;
      issued.push(turn);
      onTurn(turn);
      return {
        content: [{ type: "tool-call", toolCallId: callId(n), toolName: turn.tool, input: JSON.stringify(turn.args) }],
        finishReason: { unified: "tool-calls", raw: undefined },
        usage: NO_USAGE,
        warnings: [],
      };
    },
  });
}

function callId(n: number): string {
  return `call_scripted_${n}`;
}
