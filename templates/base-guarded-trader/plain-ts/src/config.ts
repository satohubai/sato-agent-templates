// Command line and config.json. Pure functions, so the tests can call them.

export const MODES = ["fixture", "fork", "testnet"] as const;
export type Mode = (typeof MODES)[number];

export type Args = {
  mode: Mode;
  /** testnet only: hand the prepared intent to the managed wallet. Never used in fixture or fork mode. */
  execute: boolean;
  /** fork only: write every RPC call the run makes into fixtures/ (to refresh the recordings). */
  record: boolean;
  config: string;
  policy: string;
  out: string;
};

export type Venue = "sato" | "direct";

export type AgentConfig = {
  /** "sato" = Sato Swap, the labelled default, with a no-Sato-fee quote shown alongside. "direct" = skip Sato entirely. */
  venue: Venue;
  /** Size of the agent's own trade, in USDC (a decimal string). */
  amount_usdc: string;
  /** Size of the deliberately over-cap demo intent, in USDC. The pre-flight must refuse it. */
  over_cap_amount_usdc: string;
  slippage_bps: number;
};

const DECIMAL_RE = /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/;

export class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { mode: "fixture", execute: false, record: false, config: "config.json", policy: "policy.json", out: "out" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
      return v;
    };
    if (a === "--mode") {
      const m = next();
      if (m === "mainnet") throw new UsageError("mainnet is not offered by this template. Use fixture (the default), fork or testnet.");
      if (!(MODES as readonly string[]).includes(m)) throw new UsageError(`--mode must be one of ${MODES.join(", ")}`);
      args.mode = m as Mode;
    } else if (a === "--execute") args.execute = true;
    else if (a === "--record") args.record = true;
    else if (a === "--config") args.config = next();
    else if (a === "--policy") args.policy = next();
    else if (a === "--out") args.out = next();
    else throw new UsageError(`unknown argument ${JSON.stringify(a)}`);
  }
  if (args.execute && args.mode !== "testnet") throw new UsageError("--execute is only accepted with --mode testnet; fixture and fork runs never execute");
  if (args.record && args.mode !== "fork") throw new UsageError("--record is only accepted with --mode fork");
  return args;
}

export function parseConfig(input: unknown): AgentConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new UsageError("config must be a JSON object");
  const c = input as Record<string, unknown>;
  const allowed = ["venue", "amount_usdc", "over_cap_amount_usdc", "slippage_bps"];
  for (const k of Object.keys(c)) if (!allowed.includes(k)) throw new UsageError(`config: unknown property ${JSON.stringify(k)}`);
  const venue = c.venue ?? "sato";
  if (venue !== "sato" && venue !== "direct") throw new UsageError('config.venue must be "sato" or "direct"');
  const amount = c.amount_usdc ?? "10";
  const over = c.over_cap_amount_usdc ?? "1000";
  for (const [k, v] of [["amount_usdc", amount], ["over_cap_amount_usdc", over]] as const) {
    if (typeof v !== "string" || !DECIMAL_RE.test(v) || Number(v) <= 0) throw new UsageError(`config.${k} must be a positive decimal string with at most 6 decimals`);
  }
  const slip = c.slippage_bps ?? 50;
  if (typeof slip !== "number" || !Number.isInteger(slip) || slip < 0 || slip > 5000) throw new UsageError("config.slippage_bps must be an integer in 0..5000");
  return { venue, amount_usdc: amount as string, over_cap_amount_usdc: over as string, slippage_bps: slip };
}
