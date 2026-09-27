// The OpenAI Agents SDK side of the template, in one place.
//
//   buildHost(rt)        the kit's tools as Agents SDK function tools
//                        (satoKitOpenAITools from @satohub/kit/openai-agents).
//                        Every tool the kit marks as needing a person
//                        (swap_prepare, x402_prepare, execute) carries
//                        needsApproval, so the runner stops with an
//                        interruption before it runs. The model only ever sees
//                        the kit's tools; it holds no key and builds no
//                        transaction.
//   runAgent(...)        runs an Agent with those tools through a Runner and
//                        answers every interruption with an Approver, until the
//                        run finishes. The same loop serves the scripted model
//                        (fixture mode) and a real OpenAI model (--model openai).
//   ScriptedModel        fixture mode's "model": an Agents SDK Model that emits
//                        a fixed list of tool calls and never calls an API.
//
// Every prepared intent the tools hand out is kept (recordingKit) so the report
// shows exactly what the model saw, whichever model ran.

import { Agent, Runner, Usage, type AgentInputItem, type Model, type ModelRequest, type ModelResponse } from "@openai/agents";
import { satoKitOpenAITools, type SatoKitOpenAITool } from "@satohub/kit/openai-agents";
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
  tools: SatoKitOpenAITool[];
  prepared: Prepared[];
};

export function buildHost(rt: Runtime): Host {
  const prepared: Prepared[] = [];
  const tools = satoKitOpenAITools(recordingKit(rt.kit, prepared), {
    policy: rt.policy,
    actions: CORE_ACTIONS.list(),
    signerKind: rt.signer ? rt.signer.kind : null,
    fetch: rt.mode === "fixture" ? offlineFetch : undefined,
  });
  return { tools, prepared };
}

/** The names of the tools that stop for approval (needsApproval), as the SDK decides it. */
export async function approvalTools(host: Host): Promise<string[]> {
  const out: string[] = [];
  for (const t of host.tools) {
    const needs = await t.needsApproval({} as never, {} as never, `probe-${t.name}`);
    if (needs) out.push(t.name);
  }
  return out;
}

/** The kit adapter's one result shape. */
export type Envelope =
  | { ok: true; tool: string; result: unknown }
  | { ok: false; tool: string; error: { code: string; message: string; refusals?: unknown[] }; intent?: PreparedIntent };

export type Approval = {
  tool: string;
  /** "interrupted" when the runner stopped for approval; "none" when the tool needs no person. */
  gate: "interrupted" | "none";
  approved: boolean;
  by: string;
  reason: string;
};

/** Answers an interruption. In fixture mode it is scripted; nobody is prompted. */
export type Approver = (tool: string, args: Record<string, unknown>) => Promise<{ approved: boolean; by: string; reason: string }>;

export type ToolCall = { call_id: string; tool: string; args: Record<string, unknown>; approval: Approval; envelope: Envelope | null };

function parseArgs(s: unknown): Record<string, unknown> {
  if (typeof s !== "string" || s === "") return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The envelope a tool returned, from its function_call_result item; null when it is not one (e.g. a rejection message). */
export function envelopeOf(output: unknown): Envelope | null {
  let v: unknown = output;
  if (v && typeof v === "object" && (v as { type?: string }).type === "text") v = (v as { text?: unknown }).text;
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

/** The tool calls in a finished run's history, in order, with what came back. */
export function toolCallsOf(history: readonly AgentInputItem[], approvals: ReadonlyMap<string, Approval>): ToolCall[] {
  const results = new Map<string, unknown>();
  for (const it of history) {
    const i = it as { type?: string; callId?: string; output?: unknown };
    if (i.type === "function_call_result" && i.callId) results.set(i.callId, i.output);
  }
  const calls: ToolCall[] = [];
  for (const it of history) {
    const i = it as { type?: string; callId?: string; name?: string; arguments?: string };
    if (i.type !== "function_call" || !i.callId || !i.name) continue;
    const approval = approvals.get(i.callId) ?? { tool: i.name, gate: "none" as const, approved: true, by: "no approval needed", reason: "reads or quotes only" };
    calls.push({ call_id: i.callId, tool: i.name, args: parseArgs(i.arguments), approval, envelope: approval.approved ? envelopeOf(results.get(i.callId)) : null });
  }
  return calls;
}

export type AgentRun = { calls: ToolCall[]; final_output: string; history: AgentInputItem[] };

export const INSTRUCTIONS = [
  "You run one guarded trading pass on Base with the Sato Kit's tools and nothing else.",
  "Report each swap quote with its fee disclosure verbatim, unranked; Sato Swap is labelled as Sato's.",
  "Report every pre-flight refusal as rule, limit and observed value.",
  "Ask to execute only an intent that passed the pre-flight, with { intent_id } and nothing else; a person approves or declines.",
  "Make no claim about outcomes, profit or risk.",
].join(" ");

/**
 * Runs the agent to completion. Each time the runner stops for approval, the
 * approver answers every pending call and the run resumes from its state.
 * `tracingDisabled` is always set, so nothing is exported to a tracing backend.
 */
export async function runAgent(host: Host, model: Model | string | undefined, input: string, approve: Approver, maxTurns = 12): Promise<AgentRun> {
  const agent = new Agent({ name: AGENT_NAME, instructions: INSTRUCTIONS, tools: host.tools, ...(model === undefined ? {} : { model }) });
  const runner = new Runner({ tracingDisabled: true, traceIncludeSensitiveData: false, workflowName: AGENT_NAME });
  const approvals = new Map<string, Approval>();
  let result = await runner.run(agent, input, { maxTurns });
  for (let rounds = 0; result.interruptions.length > 0; rounds++) {
    if (rounds >= maxTurns) throw new Error("too many approval rounds; stopping");
    for (const item of result.interruptions) {
      const raw = item.rawItem as { callId?: string; name?: string; arguments?: string };
      const tool = raw.name ?? item.toolName ?? "unknown";
      const args = parseArgs(raw.arguments);
      const a = await approve(tool, args);
      approvals.set(raw.callId ?? `${tool}-${approvals.size}`, { tool, gate: "interrupted", ...a });
      if (a.approved) result.state.approve(item);
      else result.state.reject(item);
    }
    result = await runner.run(agent, result.state, { maxTurns });
  }
  const history = result.history as AgentInputItem[];
  return { calls: toolCallsOf(history, approvals), final_output: String(result.finalOutput ?? ""), history };
}

// ── The scripted model ───────────────────────────────────────────────────────
//
// An Agents SDK Model that makes no API call. Each getResponse returns the
// next tool call from `next`, which sees the envelopes returned so far (parsed
// from the request's own history, exactly what a real model would read), or a
// final message when `next` returns null. Deterministic: the same results
// always give the same calls.

export type Turn = { tool: string; args: Record<string, unknown>; note: string; idea?: number };
export type Seen = { turn: Turn; envelope: Envelope | null };

export class ScriptedModel implements Model {
  readonly name: string;
  private readonly issued: Turn[] = [];
  constructor(
    private readonly next: (seen: readonly Seen[]) => Turn | null,
    name = "scripted-turns/1",
    private readonly onTurn: (t: Turn) => void = () => {},
  ) {
    this.name = name;
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const items = (Array.isArray(request.input) ? request.input : []) as Array<{ type?: string; callId?: string; output?: unknown }>;
    const seen: Seen[] = this.issued.map((turn, n) => {
      const r = items.find((i) => i.type === "function_call_result" && i.callId === callId(n));
      return { turn, envelope: r ? envelopeOf(r.output) : null };
    });
    const turn = this.next(seen);
    const usage = new Usage();
    if (!turn) {
      return {
        usage,
        responseId: `scripted-${this.issued.length}-done`,
        output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done: every call above was made by a fixed script; no model API was called." }] }],
      };
    }
    const n = this.issued.length;
    this.issued.push(turn);
    this.onTurn(turn);
    return {
      usage,
      responseId: `scripted-${n}`,
      output: [{ type: "function_call", callId: callId(n), name: turn.tool, arguments: JSON.stringify(turn.args), status: "completed" }],
    };
  }

  // eslint-disable-next-line require-yield
  async *getStreamedResponse(): AsyncIterable<never> {
    throw new Error("the scripted model does not stream");
  }
}

function callId(n: number): string {
  return `call_scripted_${n}`;
}
