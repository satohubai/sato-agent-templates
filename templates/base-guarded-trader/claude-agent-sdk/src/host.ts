// The Claude Agent SDK side of the template, in one place.
//
//   buildHost(rt)      the kit's in-process MCP server (createSatoKitSdkServer)
//                      and its PreToolUse hook (requireApprovalHook), both from
//                      @satohub/kit/claude-agent-sdk. The model only ever sees
//                      the kit's tools; it holds no key and builds no transaction.
//   runScripted(...)   fixture mode's "model": a fixed list of tool calls sent
//                      to that same server over an in-memory MCP transport, each
//                      one passed through the same hook first. No model and no
//                      Claude Code process is started.
//
// Every prepared intent the server hands out is kept (recordingKit) so the
// report shows exactly what the model saw, whichever driver ran.

import { createSatoKitSdkServer, requireApprovalHook, SATO_KIT_SERVER_NAME } from "@satohub/kit/claude-agent-sdk";
import type { HookCallback, McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CORE_ACTIONS, type Kit, type PreparedIntent } from "@satohub/kit";
import type { Runtime } from "./runtime.js";
import { USER_AGENT } from "./runtime.js";

export const SERVER_NAME = SATO_KIT_SERVER_NAME;
/** The matcher the hook is registered under: every tool of this server. */
export const HOOK_MATCHER = `^mcp__${SERVER_NAME}__`;

/** mcp__sato-kit__<tool>, the name the SDK (and the hook) sees. */
export function hostToolName(tool: string): string {
  return `mcp__${SERVER_NAME}__${tool}`;
}

/** The kit's tools that only read or quote; a live run pre-allows these and nothing else. */
export const READ_TOOLS = ["chain_read", "swap_quote", "actions_search", "actions_describe"] as const;

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
  server: McpSdkServerConfigWithInstance;
  hook: HookCallback;
  prepared: Prepared[];
};

export async function buildHost(rt: Runtime): Promise<Host> {
  const prepared: Prepared[] = [];
  const server = createSatoKitSdkServer(recordingKit(rt.kit, prepared), {
    policy: rt.policy,
    actions: CORE_ACTIONS.list(),
    signerKind: rt.signer ? rt.signer.kind : null,
    fetch: rt.mode === "fixture" ? offlineFetch : undefined,
  });
  return { server, hook: requireApprovalHook({ serverName: SERVER_NAME }), prepared };
}

/** The kit adapter's one result shape. */
export type Envelope =
  | { ok: true; tool: string; result: unknown }
  | { ok: false; tool: string; error: { code: string; message: string; refusals?: unknown[] }; intent?: PreparedIntent };

export type Turn = { tool: string; args: Record<string, unknown>; note: string; idea?: number };

export type Approval = {
  tool: string;
  /** What the hook answered: "ask" or "none" (the tool needs no person). */
  hook: "ask" | "none";
  approved: boolean;
  by: string;
  reason: string;
};

/** Answers an "ask". In fixture mode it is scripted; nobody is prompted. */
export type Approver = (tool: string, args: Record<string, unknown>, reason: string) => Promise<{ approved: boolean; by: string; reason: string }>;

export type TurnResult = { turn: Turn; approval: Approval; envelope: Envelope | null };

/** Runs the hook exactly as the SDK would before a tool call. */
export async function hookDecision(hook: HookCallback, tool: string, args: Record<string, unknown>): Promise<{ decision: "ask" | "none"; reason: string }> {
  const out = (await hook(
    { hook_event_name: "PreToolUse", tool_name: hostToolName(tool), tool_input: args, tool_use_id: `scripted-${tool}`, session_id: "scripted", transcript_path: "", cwd: process.cwd() } as never,
    `scripted-${tool}`,
    { signal: new AbortController().signal },
  )) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  const d = out.hookSpecificOutput?.permissionDecision;
  return d === "ask" ? { decision: "ask", reason: out.hookSpecificOutput?.permissionDecisionReason ?? "" } : { decision: "none", reason: "" };
}

/** An MCP client connected in memory to the SDK server: the same server object a live query() gets. */
export async function connect(server: McpSdkServerConfigWithInstance): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: USER_AGENT, version: "0.1.0" });
  await (server.instance as unknown as { connect(t: unknown): Promise<void> }).connect(a);
  await client.connect(b);
  return client;
}

export async function callTool(client: Client, tool: string, args: Record<string, unknown>): Promise<Envelope> {
  const res = (await client.callTool({ name: tool, arguments: args })) as { structuredContent?: unknown; content?: Array<{ type: string; text?: string }> };
  if (res.structuredContent && typeof res.structuredContent === "object") return res.structuredContent as Envelope;
  const text = res.content?.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text) as Envelope;
}

/**
 * Plays turns against the server. `next` sees every result so far and returns
 * the next turn, or null to stop; so a later turn (execute) can name an
 * intent id an earlier turn produced, the way a model would.
 */
export async function runScripted(
  host: Host,
  next: (done: readonly TurnResult[]) => Turn | null,
  approve: Approver,
  onTurn: (r: TurnResult) => void = () => {},
): Promise<TurnResult[]> {
  const client = await connect(host.server);
  const done: TurnResult[] = [];
  try {
    for (let turn = next(done); turn; turn = next(done)) {
      const h = await hookDecision(host.hook, turn.tool, turn.args);
      let approval: Approval = { tool: turn.tool, hook: "none", approved: true, by: "no approval needed", reason: "reads or quotes only" };
      if (h.decision === "ask") {
        const a = await approve(turn.tool, turn.args, h.reason);
        approval = { tool: turn.tool, hook: "ask", ...a };
      }
      const envelope = approval.approved ? await callTool(client, turn.tool, turn.args) : null;
      const r = { turn, approval, envelope };
      done.push(r);
      onTurn(r);
    }
  } finally {
    await client.close();
  }
  return done;
}
