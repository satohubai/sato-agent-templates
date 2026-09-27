// Base units and native units, kept apart on purpose.
//
// A balance is an INTEGER of base units. It never becomes a float: every
// balance is a decimal STRING of base units, converted to a readable "native"
// amount only by string arithmetic. Migrated unchanged in behaviour from the
// Sato Hub recipe treasury-balance-monitor (src/units.mjs).

/** Format an integer base-unit string as a native decimal string. Exact. */
export function toNative(baseUnits: string, decimals: number): string {
  if (!/^-?\d+$/.test(String(baseUnits))) throw new TypeError(`base units must be an integer string, got ${JSON.stringify(baseUnits)}`);
  const neg = String(baseUnits).startsWith("-");
  const digits = String(baseUnits).replace("-", "");
  if (decimals === 0) return (neg ? "-" : "") + digits;
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return (neg ? "-" : "") + whole + (frac ? `.${frac}` : "");
}

/** Compare two integer base-unit strings without going through a float. */
export function compareBaseUnits(a: string, b: string): -1 | 0 | 1 {
  const av = BigInt(a);
  const bv = BigInt(b);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

/** Fixed scale for USD amounts: 6 decimal places, carried as an integer. */
export const USD_SCALE = 6;
const USD_UNIT = 10n ** BigInt(USD_SCALE);

/** Parse a decimal string into an integer scaled by 10^USD_SCALE. Exact. */
export function parseUsd(decimalString: string): bigint {
  const s = String(decimalString);
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new TypeError(`a USD price must be a decimal string, got ${JSON.stringify(decimalString)}`);
  const neg = s.startsWith("-");
  const [whole, frac = ""] = s.replace("-", "").split(".");
  if (frac.length > USD_SCALE) throw new RangeError(`a USD price carries at most ${USD_SCALE} decimal places, got ${JSON.stringify(s)}`);
  const scaled = BigInt(whole) * USD_UNIT + BigInt((frac + "0".repeat(USD_SCALE)).slice(0, USD_SCALE));
  return neg ? -scaled : scaled;
}

/** Render a 10^USD_SCALE-scaled integer back to a decimal string. Exact. */
export function formatUsd(scaled: bigint): string {
  return toNative(String(scaled), USD_SCALE);
}

/**
 * The value of a holding: base units x unit price, exact integer arithmetic,
 * truncated (never rounded up) to USD_SCALE. Truncation never reports more
 * money than the inputs support.
 */
export function valueUsd(baseUnits: string, decimals: number, priceScaled: bigint): bigint {
  return (BigInt(baseUnits) * priceScaled) / 10n ** BigInt(decimals);
}
