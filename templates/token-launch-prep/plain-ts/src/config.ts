// Command line and input validation. Pure functions, so the tests can call
// them. The schema validator is the small, dependency-free one the other
// plain-ts templates use; it covers exactly the keywords schemas/input.json
// uses. Defaults are applied here, after validation, in one place.

import { getAddress, isAddress, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { DEFAULT_FEE_BPS, type LaunchChain, type PoolPreset } from "./clanker.js";
import type { RewardToken } from "./rewards.js";

export const MODES = ["fixture", "fork", "rpc"] as const;
export type Mode = (typeof MODES)[number];

export type Args = {
  mode: Mode;
  config: string;
  policy: string;
  out: string;
  rpc?: string;
  /** fork only: write every RPC answer the run needed into fixtures/rpc.json. */
  record: boolean;
};

export class UsageError extends Error {}
export class ConfigError extends Error {}

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = {}): Args {
  const args: Args = { mode: "fixture", config: "config.json", policy: "policy.json", out: "out", record: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
      return v;
    };
    if (a === "--mode") {
      const m = next();
      if (!(MODES as readonly string[]).includes(m)) throw new UsageError(`--mode must be one of ${MODES.join(", ")}`);
      args.mode = m as Mode;
    } else if (a === "--config") args.config = next();
    else if (a === "--policy") args.policy = next();
    else if (a === "--out") args.out = next();
    else if (a === "--rpc") args.rpc = next();
    else if (a === "--record") args.record = true;
    else throw new UsageError(`unknown argument ${JSON.stringify(a)}`);
  }
  if (args.record && args.mode !== "fork") throw new UsageError("--record is only accepted with --mode fork");
  if (args.mode === "rpc") {
    args.rpc ??= env.SATO_RPC_URL_BASE || undefined;
    if (!args.rpc) throw new UsageError("--mode rpc needs --rpc <url> or SATO_RPC_URL_BASE; this template ships no default endpoint");
  }
  if (args.rpc && args.mode !== "rpc") throw new UsageError("--rpc is only accepted with --mode rpc");
  return args;
}

// ── schema validation ────────────────────────────────────────────────────────

type Schema = {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  items?: Schema;
  required?: string[];
  additionalProperties?: boolean;
  properties?: Record<string, Schema>;
};

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer";
  return typeof v;
}

function typeMatches(v: unknown, want: string | string[]): boolean {
  if (Array.isArray(want)) return want.some((w) => typeMatches(v, w));
  const actual = typeOf(v);
  if (want === "number") return actual === "number" || actual === "integer";
  return actual === want;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

/** Errors as readable sentences, path first. Empty array means valid. */
export function validateConfig(value: unknown, schema: Schema, path = "input"): string[] {
  const errors: string[] = [];
  if (schema.type !== undefined && !typeMatches(value, schema.type)) {
    errors.push(`${path} must be ${Array.isArray(schema.type) ? schema.type.join(" or ") : schema.type}, found ${typeOf(value)}`);
    return errors;
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path} must be ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${path} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  if (typeof value === "string") {
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path} is longer than ${schema.maxLength} characters`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path} is shorter than ${schema.minLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) errors.push(`${path} does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} must be at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} needs at least ${schema.minItems} item(s), found ${value.length}`);
    if (schema.items) value.forEach((v, i) => errors.push(...validateConfig(v, schema.items as Schema, `${path}[${i}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) if (!(req in obj)) errors.push(`${path}.${req} is required and is missing`);
    if (schema.additionalProperties === false && schema.properties) {
      for (const k of Object.keys(obj)) {
        if (!(k in schema.properties)) {
          const near = Object.keys(schema.properties).filter((p) => editDistance(p, k) <= 2);
          errors.push(`${path}.${k} is not a property of this schema${near.length ? ` (did you mean ${near.join(" or ")}?)` : ""}`);
        }
      }
    }
    for (const [k, sub] of Object.entries(schema.properties ?? {})) if (k in obj) errors.push(...validateConfig(obj[k], sub, `${path}.${k}`));
  }
  return errors;
}

// ── the launch input ─────────────────────────────────────────────────────────

/** As written in config.json (schemas/input.json). */
export type LaunchInputRaw = {
  chain?: LaunchChain;
  name: string;
  symbol: string;
  creator: string;
  sender?: string;
  image?: string;
  description?: string;
  interface_name?: string;
  salt?: string;
  pool_preset?: PoolPreset;
  fees?: { clanker_fee_bps?: number; paired_fee_bps?: number };
  reward_token?: RewardToken;
};

/** After validation, with every default applied. */
export type LaunchInput = {
  chain: LaunchChain;
  name: string;
  symbol: string;
  creator: Address;
  sender: Address;
  image: string;
  description: string | null;
  interface_name: string;
  salt: Hex;
  pool_preset: PoolPreset;
  clanker_fee_bps: number;
  paired_fee_bps: number;
  reward_token: RewardToken;
};

export const DEFAULT_INTERFACE_NAME = "token-launch-prep";

/** A property name that looks like it carries a key. This template takes none, in any form. */
const KEY_LIKE = /(private|secret|mnemonic|seed|passphrase|password|signer|api_?key|keystore)/i;

function keyLikeProperties(v: unknown, path = "input"): string[] {
  if (!v || typeof v !== "object") return [];
  const out: string[] = [];
  for (const [k, sub] of Object.entries(v as Record<string, unknown>)) {
    if (KEY_LIKE.test(k)) out.push(`${path}.${k}`);
    out.push(...keyLikeProperties(sub, `${path}.${k}`));
  }
  return out;
}

function address(v: string, field: string, errors: string[]): Address {
  if (!isAddress(v, { strict: false })) {
    errors.push(`input.${field} is not an EVM address`);
    return zeroAddress;
  }
  // A mixed-case address must carry a valid EIP-55 checksum; all-lower or all-upper is accepted as written.
  if (/[a-f]/.test(v.slice(2)) && /[A-F]/.test(v.slice(2)) && !isAddress(v, { strict: true })) {
    errors.push(`input.${field} has an invalid EIP-55 checksum; check the address or write it in lower case`);
    return zeroAddress;
  }
  const a = getAddress(v);
  if (a === zeroAddress) errors.push(`input.${field} cannot be the zero address`);
  return a;
}

/** Validate against schemas/input.json, refuse anything key-like, apply defaults. Throws ConfigError with every problem at once. */
export function parseLaunchInput(value: unknown, schema: Schema, label = "the input"): LaunchInput {
  const keyish = keyLikeProperties(value);
  if (keyish.length) {
    throw new ConfigError(
      `${label} carries ${keyish.join(", ")}. This template takes no private key, seed, secret or signer in any form: it prepares an unsigned transaction and you sign it in your own wallet.`,
    );
  }
  const errors = validateConfig(value, schema);
  if (errors.length) throw new ConfigError(`${label} does not match schemas/input.json:\n  - ${errors.join("\n  - ")}`);
  const raw = value as LaunchInputRaw;
  const sem: string[] = [];
  const creator = address(raw.creator, "creator", sem);
  const sender = raw.sender === undefined ? creator : address(raw.sender, "sender", sem);
  if (sem.length) throw new ConfigError(`${label} is not usable:\n  - ${sem.join("\n  - ")}`);
  return {
    chain: raw.chain ?? "base",
    name: raw.name,
    symbol: raw.symbol,
    creator,
    sender,
    image: raw.image ?? "",
    description: raw.description ?? null,
    interface_name: raw.interface_name ?? DEFAULT_INTERFACE_NAME,
    salt: (raw.salt ?? zeroHash).toLowerCase() as Hex,
    pool_preset: raw.pool_preset ?? "standard",
    clanker_fee_bps: raw.fees?.clanker_fee_bps ?? DEFAULT_FEE_BPS,
    paired_fee_bps: raw.fees?.paired_fee_bps ?? DEFAULT_FEE_BPS,
    reward_token: raw.reward_token ?? "Both",
  };
}
