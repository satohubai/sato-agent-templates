// Command line and config.json. Pure functions, so the tests can call them.

import { solToLamports } from "./tokens.js";

export const MODES = ["fixture", "live"] as const;
export type Mode = (typeof MODES)[number];

export type Args = {
  mode: Mode;
  /** live only: you have read the README section "Mainnet" and accept that the output is a real transaction you could sign. */
  accept_mainnet_risk: boolean;
  /** live only: write every RPC answer and venue response into fixtures/ (builds intents for the fixed fixture wallet). */
  record: boolean;
  config: string;
  policy: string;
  out: string;
  /** Where the live-mode state (price high-water mark, day's prepared total) is kept. */
  state_dir: string;
};

export type Venue = "sato" | "direct";

export type AgentConfig = {
  /** Your PUBLIC address: the wallet watched, and the fee payer of the prepared transaction. Null until you set it. */
  wallet: string | null;
  /** SOL sold per swap, a decimal string. */
  sell_sol: string;
  /** SOL that must stay in the wallet after a swap (fees, rent). */
  keep_sol: string;
  /** Prepare a swap when the SOL price is at least this many percent below the reference. */
  drop_pct: number;
  /** The price (USD per SOL) a drop is measured from. Null = the highest price this agent has seen (kept in .sato/state.json). */
  reference_price_usd: number | null;
  /** "sato" = Sato Route, the labelled default, with a no-Sato-fee Jupiter quote shown alongside. "direct" = Jupiter only; Sato is not contacted. */
  venue: Venue;
  slippage_bps: number;
};

export class UsageError extends Error {}

/** A Solana public key is 32 bytes: 32 to 44 base58 characters. A 64-byte secret key is 86 to 88. */
const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LOOKS_LIKE_SECRET_RE = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;
const KEYISH_NAME_RE = /(private|secret|mnemonic|seed|keypair|passphrase|signer)/i;

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { mode: "fixture", accept_mainnet_risk: false, record: false, config: "config.json", policy: "policy.json", out: "out", state_dir: ".sato" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
      return v;
    };
    if (a === "--mode") {
      const m = next();
      if (m === "mainnet") throw new UsageError('there is no "mainnet" mode. Use --mode live --accept-mainnet-risk to read mainnet and prepare an unsigned transaction.');
      if (!(MODES as readonly string[]).includes(m)) throw new UsageError(`--mode must be one of ${MODES.join(", ")}`);
      args.mode = m as Mode;
    } else if (a === "--accept-mainnet-risk") args.accept_mainnet_risk = true;
    else if (a === "--record") args.record = true;
    else if (a === "--config") args.config = next();
    else if (a === "--policy") args.policy = next();
    else if (a === "--out") args.out = next();
    else if (a === "--state-dir") args.state_dir = next();
    else throw new UsageError(`unknown argument ${JSON.stringify(a)}. This template has no --execute or --sign: it stops at an unsigned transaction.`);
  }
  if (args.mode === "live" && !args.accept_mainnet_risk) {
    throw new UsageError("live mode reads Solana mainnet and builds a real, unsigned transaction. Add --accept-mainnet-risk to say you understand that (see README, \"Mainnet\"). Nothing is signed or sent either way.");
  }
  if (args.mode === "fixture" && args.accept_mainnet_risk) throw new UsageError("--accept-mainnet-risk only means something with --mode live");
  if (args.record && args.mode !== "live") throw new UsageError("--record is only accepted with --mode live");
  return args;
}

export function isPublicKey(s: unknown): s is string {
  return typeof s === "string" && PUBKEY_RE.test(s);
}

const SOL_AMOUNT_ERR = "a positive decimal string with at most 9 places, e.g. \"0.1\"";

function solField(c: Record<string, unknown>, k: string, dflt: string, allowZero: boolean): string {
  const v = c[k] ?? dflt;
  if (typeof v !== "string") throw new UsageError(`config.${k} must be ${SOL_AMOUNT_ERR}`);
  let l: bigint;
  try {
    l = solToLamports(v);
  } catch {
    throw new UsageError(`config.${k} must be ${SOL_AMOUNT_ERR}`);
  }
  if (l === 0n && !allowZero) throw new UsageError(`config.${k} must be ${SOL_AMOUNT_ERR}`);
  return v;
}

export function parseConfig(input: unknown): AgentConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new UsageError("config must be a JSON object");
  const c = input as Record<string, unknown>;
  const allowed = ["wallet", "sell_sol", "keep_sol", "drop_pct", "reference_price_usd", "venue", "slippage_bps"];
  for (const k of Object.keys(c)) {
    if (KEYISH_NAME_RE.test(k)) throw new UsageError(`config: "${k}" looks like a key field. This template holds no key and has no signer: it stops at an unsigned transaction. Put only your public address in "wallet".`);
    if (!allowed.includes(k)) throw new UsageError(`config: unknown property ${JSON.stringify(k)}`);
  }

  let wallet: string | null = null;
  if (c.wallet !== undefined && c.wallet !== null) {
    if (typeof c.wallet !== "string") throw new UsageError("config.wallet must be a Solana public address (base58) or null");
    if (LOOKS_LIKE_SECRET_RE.test(c.wallet) || !PUBKEY_RE.test(c.wallet)) {
      throw new UsageError(LOOKS_LIKE_SECRET_RE.test(c.wallet) ? "config.wallet looks like a secret key, not an address. Never put a key in this repository. Use the public address (32 to 44 characters)." : "config.wallet must be a Solana public address (32 to 44 base58 characters)");
    }
    wallet = c.wallet;
  }

  const sell = solField(c, "sell_sol", "0.1", false);
  const keep = solField(c, "keep_sol", "0.05", true);

  const drop = c.drop_pct ?? 5;
  if (typeof drop !== "number" || !Number.isFinite(drop) || drop <= 0 || drop >= 100) throw new UsageError("config.drop_pct must be a number above 0 and below 100");

  const ref = c.reference_price_usd ?? null;
  if (ref !== null && (typeof ref !== "number" || !Number.isFinite(ref) || ref <= 0)) throw new UsageError("config.reference_price_usd must be a positive number or null");

  const venue = c.venue ?? "sato";
  if (venue !== "sato" && venue !== "direct") throw new UsageError('config.venue must be "sato" or "direct"');

  const slip = c.slippage_bps ?? 50;
  if (typeof slip !== "number" || !Number.isInteger(slip) || slip < 0 || slip > 5000) throw new UsageError("config.slippage_bps must be an integer in 0..5000");

  return { wallet, sell_sol: sell, keep_sol: keep, drop_pct: drop, reference_price_usd: ref as number | null, venue, slippage_bps: slip };
}
