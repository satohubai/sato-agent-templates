// Command line and config.json. Pure functions, so the tests can call them.

export const MODES = ["fixture", "fork", "testnet", "sato-os"] as const;
/** --mode sato-os only: where market reads and quotes come from. "live" = BASE_RPC_URL; "fixture" = the recordings (offline). */
export const DATA_SOURCES = ["live", "fixture"] as const;
export type DataSource = (typeof DATA_SOURCES)[number];
export type Mode = (typeof MODES)[number];

export const MODEL_KINDS = ["scripted", "live"] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];
/**
 * A live run has no default model: --model-id names a provider string such as
 * openai/gpt-5, resolved by the AI SDK's default provider.
 */
export const DEFAULT_MODEL_ID: string | null = null;

export type Args = {
  mode: Mode;
  /**
   * "scripted" (default): the AI SDK's mock model (ai/test) drives
   * generateText from a script; no model API is called. "live": a real run
   * through the AI SDK; needs --model-id and AI_GATEWAY_API_KEY.
   */
  model: ModelKind;
  /** --model live only: a provider string, e.g. openai/gpt-5. */
  model_id: string | null;
  /** testnet only: hand the prepared intent to the managed wallet. Never used in fixture or fork mode. */
  execute: boolean;
  /** fork only: write every RPC call the run makes into fixtures/ (to refresh the recordings). */
  record: boolean;
  /** --mode sato-os only: "live" (default) reads Base through BASE_RPC_URL; "fixture" answers from the recordings. */
  data: DataSource;
  /** Where sato-os:attach stored the Sato OS token (default .sato). */
  sato_dir: string;
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
  const args: Args = { mode: "fixture", model: "scripted", model_id: DEFAULT_MODEL_ID, execute: false, record: false, data: "live", sato_dir: ".sato", config: "config.json", policy: "policy.json", out: "out" };
  let dataGiven = false;
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
    } else if (a === "--model") {
      const m = next();
      if (!(MODEL_KINDS as readonly string[]).includes(m)) throw new UsageError(`--model must be one of ${MODEL_KINDS.join(", ")}`);
      args.model = m as ModelKind;
    } else if (a === "--model-id") args.model_id = next();
    else if (a === "--execute") args.execute = true;
    else if (a === "--record") args.record = true;
    else if (a === "--data") {
      const d = next();
      if (!(DATA_SOURCES as readonly string[]).includes(d)) throw new UsageError(`--data must be one of ${DATA_SOURCES.join(", ")}`);
      args.data = d as DataSource;
      dataGiven = true;
    } else if (a === "--sato-dir") args.sato_dir = next();
    else if (a === "--config") args.config = next();
    else if (a === "--policy") args.policy = next();
    else if (a === "--out") args.out = next();
    else throw new UsageError(`unknown argument ${JSON.stringify(a)}`);
  }
  if (args.execute && args.mode !== "testnet") throw new UsageError("--execute is only accepted with --mode testnet; fixture and fork runs never execute");
  if (args.model_id !== DEFAULT_MODEL_ID && args.model !== "live") throw new UsageError("--model-id is only accepted with --model live");
  if (args.model === "live" && args.model_id === null) throw new UsageError("--model live needs --model-id <provider>/<model>, e.g. --model-id openai/gpt-5");
  if (args.record && args.model !== "scripted") throw new UsageError("--record is only accepted with the scripted model, so recordings stay reproducible");
  if (args.record && args.mode !== "fork") throw new UsageError("--record is only accepted with --mode fork");
  if (dataGiven && args.mode !== "sato-os") throw new UsageError("--data is only accepted with --mode sato-os");
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
