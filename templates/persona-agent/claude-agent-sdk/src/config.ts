export type Mode = "fixture" | "fork" | "testnet";

export class UsageError extends Error {}

export type Args = { mode: Mode; config: string; policy: string; character: string; out: string; once: boolean; allowExecute: boolean };

export function parseArgs(argv: string[]): Args {
  const a: Args = { mode: "fixture", config: "config.json", policy: "policy.json", character: "character.json", out: "out", once: false, allowExecute: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new UsageError(`${k} needs a value`);
      return x;
    };
    if (k === "--mode") {
      const m = v();
      if (m === "mainnet") throw new UsageError("this template has no mainnet mode");
      if (m !== "fixture" && m !== "fork" && m !== "testnet") throw new UsageError(`--mode must be fixture, fork or testnet, not ${m}`);
      a.mode = m;
    } else if (k === "--config") a.config = v();
    else if (k === "--policy") a.policy = v();
    else if (k === "--character") a.character = v();
    else if (k === "--out") a.out = v();
    else if (k === "--once") a.once = true;
    else if (k === "--allow-execute") a.allowExecute = true;
    else throw new UsageError(`unknown argument ${k}`);
  }
  if (a.allowExecute && a.mode !== "testnet") throw new UsageError("--allow-execute works on testnet only; fixture and fork runs never execute");
  return a;
}

export type AgentConfig = {
  model: string;
  max_turns: number;
  memory_path: string;
  memory_top_k: number;
  slippage_bps: number;
  venue: "sato" | "direct";
  poll_interval_s: number;
};

export function parseConfig(raw: unknown): AgentConfig {
  const c = raw as Partial<AgentConfig>;
  const num = /^[0-9]+(\.[0-9]+)?$/;
  const errs: string[] = [];
  if (typeof c.model !== "string" || !c.model) errs.push("model");
  if (!Number.isInteger(c.max_turns) || (c.max_turns as number) < 1) errs.push("max_turns");
  if (typeof c.memory_path !== "string" || !c.memory_path) errs.push("memory_path");
  if (!Number.isInteger(c.memory_top_k) || (c.memory_top_k as number) < 0) errs.push("memory_top_k");
  if (!Number.isInteger(c.slippage_bps) || (c.slippage_bps as number) < 0) errs.push("slippage_bps");
  if (c.venue !== "sato" && c.venue !== "direct") errs.push("venue (sato | direct)");
  if (typeof c.poll_interval_s !== "number" || c.poll_interval_s < 1) errs.push("poll_interval_s");
  if (errs.length) throw new UsageError(`config.json: invalid ${errs.join(", ")}`);
  return c as AgentConfig;
}
