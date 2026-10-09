// The two mints this agent knows. It sells SOL and buys USDC; there is no
// config field for any other pair.

export const WSOL_MINT = "So11111111111111111111111111111111111111112" as const;
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as const;
export const SOL_DECIMALS = 9;
export const USDC_DECIMALS = 6;
export const LAMPORTS_PER_SOL = 1_000_000_000n;

const SOL_RE = /^(?:0|[1-9][0-9]{0,6})(?:\.[0-9]{1,9})?$/;

/** "0.1" -> 100000000n lamports. Throws on anything that is not a plain decimal with at most 9 places. */
export function solToLamports(s: string): bigint {
  if (!SOL_RE.test(s)) throw new Error(`${JSON.stringify(s)} is not a SOL amount (a decimal with at most 9 places)`);
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * LAMPORTS_PER_SOL + BigInt(frac.padEnd(SOL_DECIMALS, "0"));
}

/** Lamports to a SOL string with no rounding: 100000000n -> "0.1". */
export function lamportsToSol(l: bigint): string {
  const whole = l / LAMPORTS_PER_SOL;
  const frac = (l % LAMPORTS_PER_SOL).toString().padStart(SOL_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** USDC base units to a number of dollars, counting 1 USDC as 1 USD (stated wherever it is shown). */
export function usdcToUsd(base: string): number {
  const v = BigInt(base);
  return Number(v / 1_000_000n) + Number(v % 1_000_000n) / 1_000_000;
}
