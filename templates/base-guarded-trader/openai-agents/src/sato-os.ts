// The Sato OS hand-off (optional). Sato OS is the self-hosted runtime where a
// person approves each action and where signing happens.
//
//   npm run sato-os:attach -- --url <your Sato OS> --wallet <0x…>
//     attaches this agent and stores its scoped token in .sato/sato-os.json
//   npm start -- --mode sato-os
//     prepares intents with the kit exactly as the other modes do, then files
//     each one the pre-flight ALLOWED as a proposal in Sato OS. A refused
//     intent is never sent. Nothing here holds a key, signs or broadcasts.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PreparedIntent } from "@satohub/kit";
import { FIXTURE_CLOCK_MS } from "./runtime.js";
import { attachToSatoOs, proposeIntent, readSatoOsConfig, SatoOsError, type AttachResult, type SatoOsFetch } from "@satohub/kit/sato-os";

export const DEFAULT_SATO_DIR = ".sato";
/** Not secret: the wallet the attach named, so --mode sato-os builds intents for it. */
export const SATO_OS_AGENT_FILE = "sato-os.agent.json";
export const DEFAULT_CHAINS = ["Base"];
export const DEFAULT_GOAL = "A guarded Base trading agent: quotes, prepares and pre-flights swaps with the Sato Kit and hands allowed intents to Sato OS for approval.";

export class AttachUsageError extends Error {}

export type AttachArgs = {
  url: string;
  wallet: `0x${string}`;
  name: string;
  goal: string;
  chains: string[];
  dir: string;
  overwrite: boolean;
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function parseAttachArgs(argv: readonly string[], env: NodeJS.ProcessEnv): AttachArgs {
  let url = env.SATO_OS_URL ?? "";
  let wallet = env.SATO_OS_WALLET ?? "";
  let name = "base-guarded-trader";
  let goal = DEFAULT_GOAL;
  let chains = DEFAULT_CHAINS;
  let dir = DEFAULT_SATO_DIR;
  let overwrite = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new AttachUsageError(`${a} needs a value`);
      return v;
    };
    if (a === "--url") url = next();
    else if (a === "--wallet") wallet = next();
    else if (a === "--name") name = next();
    else if (a === "--goal") goal = next();
    else if (a === "--chains") chains = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--dir") dir = next();
    else if (a === "--overwrite") overwrite = true;
    else throw new AttachUsageError(`unknown argument ${JSON.stringify(a)}`);
  }
  if (!url) throw new AttachUsageError("Name your Sato OS instance: --url https://your-sato-os.example (or set SATO_OS_URL).");
  if (!/^https?:\/\/.+/.test(url)) throw new AttachUsageError("--url must be an http(s) URL");
  if (!ADDRESS_RE.test(wallet)) throw new AttachUsageError("Name the agent's wallet address in Sato OS: --wallet 0x… (or set SATO_OS_WALLET). It is an address, never a key.");
  if (goal.trim().length < 12) throw new AttachUsageError("--goal must be at least 12 characters");
  if (chains.length === 0) throw new AttachUsageError("--chains needs at least one chain, e.g. Base");
  return { url, wallet: wallet as `0x${string}`, name, goal, chains, dir, overwrite };
}

/** Attaches to Sato OS. The token goes to <dir>/sato-os.json (0600, gitignored) and is never printed. */
export async function runAttach(args: AttachArgs, fetchImpl?: SatoOsFetch): Promise<AttachResult> {
  const res = await attachToSatoOs({
    baseUrl: args.url,
    name: args.name,
    goal: args.goal,
    walletAddresses: [args.wallet],
    chains: args.chains,
    agentType: "trading",
    dir: args.dir,
    overwrite: args.overwrite,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  writeFileSync(join(args.dir, SATO_OS_AGENT_FILE), JSON.stringify({ wallet: args.wallet, chains: args.chains, agent_id: res.agent_id }, null, 2) + "\n");
  return res;
}

/** The wallet --mode sato-os builds intents for: SATO_OS_WALLET, else the one the attach named. */
export function satoOsWallet(dir: string, env: NodeJS.ProcessEnv): `0x${string}` {
  const fromEnv = env.SATO_OS_WALLET;
  if (fromEnv) {
    if (!ADDRESS_RE.test(fromEnv)) throw new Error("SATO_OS_WALLET is not a 0x address");
    return fromEnv as `0x${string}`;
  }
  let meta: { wallet?: string };
  try {
    meta = JSON.parse(readFileSync(join(dir, SATO_OS_AGENT_FILE), "utf8"));
  } catch {
    throw new Error(`--mode sato-os needs an attached agent: run npm run sato-os:attach first (no ${join(dir, SATO_OS_AGENT_FILE)}).`);
  }
  if (!meta.wallet || !ADDRESS_RE.test(meta.wallet)) throw new Error(`${join(dir, SATO_OS_AGENT_FILE)} has no wallet address`);
  return meta.wallet as `0x${string}`;
}

export type HandOffItem = { label: string; intent: PreparedIntent };

export type HandOffResult = {
  label: string;
  intent_id: string;
  proposed: boolean;
  proposal_id: string | null;
  status: string | null;
  /** Why it was not proposed: the refused rules, or the error Sato OS answered. */
  reason: string | null;
};

/**
 * Files each ALLOWED intent as a Sato OS proposal. A refused intent is
 * recorded as not proposed and no request is made for it. Sato OS decides
 * from there: a person approves, and Sato OS signs; this agent never does.
 */
export async function handOff(items: readonly HandOffItem[], opts: { dir: string; clock: () => number; fetch?: SatoOsFetch }): Promise<HandOffResult[]> {
  const cfg = await readSatoOsConfig(opts.dir);
  const out: HandOffResult[] = [];
  for (const { label, intent } of items) {
    const base = { label, intent_id: intent.intent_id };
    if (!intent.policy.ok) {
      const rules = intent.policy.refusals.map((r) => r.rule).join(", ") || "unnamed";
      out.push({ ...base, proposed: false, proposal_id: null, status: null, reason: `refused by the pre-flight (${rules}); refused intents are never proposed` });
      continue;
    }
    try {
      const r = await proposeIntent(intent, {
        baseUrl: cfg.base_url,
        token: cfg.token,
        agentId: cfg.agent_id,
        mcpEndpoint: cfg.mcp_endpoint,
        clock: opts.clock,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      });
      out.push({ ...base, proposed: true, proposal_id: r.proposal_id, status: r.status, reason: null });
    } catch (e) {
      const msg = e instanceof SatoOsError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
      out.push({ ...base, proposed: false, proposal_id: null, status: null, reason: msg });
    }
  }
  return out;
}

/** --mode sato-os wiring for buildRuntime: fails early when the agent is not attached. */
export async function satoOsRuntimeOptions(args: { data: "live" | "fixture"; sato_dir: string }, env: NodeJS.ProcessEnv): Promise<{ rpcUrl: string | null; taker: `0x${string}` }> {
  await readSatoOsConfig(args.sato_dir); // throws "attach first" when there is no token
  const taker = satoOsWallet(args.sato_dir, env);
  if (args.data === "fixture") return { rpcUrl: null, taker };
  const rpcUrl = env.BASE_RPC_URL;
  if (!rpcUrl) throw new Error("--mode sato-os reads Base through BASE_RPC_URL (read-only; no key). Set it, or pass --data fixture for an offline run.");
  return { rpcUrl, taker };
}

/** The clock proposals are checked against: the recordings' clock with --data fixture, else now. */
export function satoOsClock(data: "live" | "fixture"): () => number {
  return data === "fixture" ? () => FIXTURE_CLOCK_MS : () => Date.now();
}

export function printHandOff(results: readonly HandOffResult[], print: (label: string, value: string) => void): void {
  for (const r of results) {
    print(r.proposed ? "proposed" : "not proposed", r.proposed ? `${r.label} → Sato OS proposal ${r.proposal_id} (${r.status})` : `${r.label} — ${r.reason}`);
  }
}
