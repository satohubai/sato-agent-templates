// The watch: has the SOL price fallen far enough to prepare a swap?
//
// The price is the one the Jupiter quote implies for the amount being sold
// (USDC out per SOL in, with USDC counted as 1 USD). It is a quote, not an
// oracle: it includes the route's price impact, and a quote is not a fill.
//
// The reference a drop is measured from is, in order: reference_price_usd in
// config.json, else the highest price this agent has seen (kept in
// .sato/state.json). With neither, the first run records the price and waits.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LAMPORTS_PER_SOL, usdcToUsd } from "./tokens.js";

/** USD per SOL implied by selling `lamports` for `usdcOutBase` USDC base units. */
export function impliedPriceUsd(lamports: bigint, usdcOutBase: string): number {
  if (lamports <= 0n) throw new Error("lamports must be positive");
  return (usdcToUsd(usdcOutBase) * Number(LAMPORTS_PER_SOL)) / Number(lamports);
}

export type Decision =
  | { fire: true; price_usd: number; reference_usd: number; reference_source: "config" | "state"; drop_pct: number; why: string }
  | { fire: false; price_usd: number | null; reference_usd: number | null; reference_source: "config" | "state" | "none"; drop_pct: number | null; why: string };

export function decide(price: number | null, reference: { usd: number; source: "config" | "state" } | null, threshold: number): Decision {
  if (price === null || !Number.isFinite(price) || price <= 0) {
    return { fire: false, price_usd: null, reference_usd: reference?.usd ?? null, reference_source: reference?.source ?? "none", drop_pct: null, why: "no price could be read, so nothing is prepared" };
  }
  if (!reference) {
    return { fire: false, price_usd: price, reference_usd: null, reference_source: "none", drop_pct: null, why: "no reference price yet; this price is recorded as the reference and nothing is prepared" };
  }
  const drop = ((reference.usd - price) / reference.usd) * 100;
  const rounded = Math.round(drop * 100) / 100;
  if (drop >= threshold) {
    return { fire: true, price_usd: price, reference_usd: reference.usd, reference_source: reference.source, drop_pct: rounded, why: `SOL is ${rounded}% below the reference ${reference.usd}, past the ${threshold}% threshold` };
  }
  return { fire: false, price_usd: price, reference_usd: reference.usd, reference_source: reference.source, drop_pct: rounded, why: `SOL is ${rounded}% below the reference ${reference.usd}; the threshold is ${threshold}%` };
}

// ── state kept between live runs ─────────────────────────────────────────────

export type State = { high_price_usd: number | null };

export function loadState(dir: string): State {
  const f = join(dir, "state.json");
  if (!existsSync(f)) return { high_price_usd: null };
  const j = JSON.parse(readFileSync(f, "utf8")) as { high_price_usd?: unknown };
  if (j.high_price_usd === null) return { high_price_usd: null };
  if (typeof j.high_price_usd !== "number" || !Number.isFinite(j.high_price_usd) || j.high_price_usd <= 0) throw new Error(`${f}: high_price_usd must be a positive number or null`);
  return { high_price_usd: j.high_price_usd };
}

export function saveState(dir: string, s: State): void {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "state.json");
  const tmp = join(dirname(f), `.state.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  renameSync(tmp, f);
}
