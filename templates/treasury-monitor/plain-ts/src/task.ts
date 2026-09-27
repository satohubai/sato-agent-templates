// The monitor's task, as a pure function of (input, source).
//
// Migrated from the Sato Hub recipe treasury-balance-monitor (src/task.mjs).
// Three things it is careful about:
//
// 1. A MISSING PRICE NEVER BECOMES A NUMBER. value_usd and price_source are
//    null, the asset is named in `unknowns`, and total_usd is null the moment
//    any holding is unpriced. A partial sum is never presented as a total.
// 2. BOTH UNITS, ALWAYS. base_units (exact integer string) and native (exact
//    decimal string) travel together.
// 3. A THRESHOLD FIRES ONCE PER CROSSING, not once per run. The checkpoint
//    carries which conditions were already true; a condition that is still
//    true is not a new crossing.

import { compareBaseUnits, formatUsd, parseUsd, toNative, valueUsd } from "./units.js";

export const OUTPUT_SCHEMA_ID = "sato.template.treasury-monitor.output/v1";

export type Asset = { id: string; symbol: string; decimals: number; token?: string | null };
export type Holder = { label: string; address: string; chain: number; assets: string[] };
export type Threshold = { chain: number; address: string; asset: string; direction: "below" | "above"; base_units: string };
export type Price = { asset: string; usd: string; source: string };
export type MonitorInput = {
  now?: string;
  assets: Asset[];
  addresses: Holder[];
  thresholds?: Threshold[];
  prices?: Price[];
  checkpoint?: { firing?: string[] };
};

export type BalanceRead = { ok: true; base_units: string; chain: string; block_number: string } | { ok: false; reason: string };

/** Where balances come from. The kit-backed source is the only one the agent uses. */
export type BalanceSource = {
  kind: "fixture" | "fork" | "rpc";
  balanceOf(chainId: number, address: string, asset: Asset): Promise<BalanceRead>;
};

export type Unknown = { kind: "unknown_asset" | "balance_unavailable" | "price_unavailable" | "threshold_unevaluated"; detail: string };

export type Balance = {
  address_label: string;
  address: string;
  chain: number;
  asset: string;
  decimals: number;
  base_units: string;
  native: string;
  price_usd: string | null;
  value_usd: string | null;
  price_source: string | null;
};

export type Alert = {
  id: string;
  address_label: string;
  address: string;
  chain: number;
  asset: string;
  direction: "below" | "above";
  threshold_base_units: string;
  observed_base_units: string;
  observed_native: string;
};

export type MonitorOutput = {
  schema: typeof OUTPUT_SCHEMA_ID;
  generated_at: string;
  source_kind: BalanceSource["kind"];
  read_at: { chain: string; block_number: string }[];
  balances: Balance[];
  total_usd: string | null;
  alerts: Alert[];
  unknowns: Unknown[];
  checkpoint: { firing: string[] };
};

export function thresholdKey(t: Threshold): string {
  return `${t.chain}|${t.address.toLowerCase()}|${t.asset}|${t.direction}|${t.base_units}`;
}

export async function runTask(input: MonitorInput, source: BalanceSource, now: string): Promise<MonitorOutput> {
  const unknowns: Unknown[] = [];
  const balances: Balance[] = [];
  const blocks = new Map<string, string>();
  const assetsById = new Map(input.assets.map((a) => [a.id, a]));
  const prices = new Map((input.prices ?? []).map((p) => [p.asset, p]));

  for (const holder of input.addresses) {
    for (const assetId of holder.assets) {
      const asset = assetsById.get(assetId);
      if (!asset) {
        unknowns.push({ kind: "unknown_asset", detail: `address ${holder.label} references asset ${assetId}` });
        continue;
      }
      const read = await source.balanceOf(holder.chain, holder.address, asset);
      if (!read.ok) {
        // Not zero. We did not learn the balance; saying 0 would be a claim.
        unknowns.push({ kind: "balance_unavailable", detail: `no balance for ${asset.symbol} at ${holder.label} on chain ${holder.chain}: ${read.reason}` });
        continue;
      }
      blocks.set(read.chain, read.block_number);
      const price = prices.get(asset.id) ?? null;
      if (price === null) {
        unknowns.push({ kind: "price_unavailable", detail: `no price source for ${asset.symbol}; the holding is reported without a valuation` });
      }
      balances.push({
        address_label: holder.label,
        address: holder.address,
        chain: holder.chain,
        asset: asset.symbol,
        decimals: asset.decimals,
        base_units: read.base_units,
        native: toNative(read.base_units, asset.decimals),
        // The UNIT price and the VALUE of this holding are different numbers.
        price_usd: price === null ? null : price.usd,
        value_usd: price === null ? null : formatUsd(valueUsd(read.base_units, asset.decimals, parseUsd(price.usd))),
        price_source: price === null ? null : price.source,
      });
    }
  }

  // "I valued nothing" and "the treasury holds nothing" are different claims.
  const anyUnpriced = balances.some((b) => b.value_usd === null);
  const total_usd = balances.length === 0 || anyUnpriced ? null : formatUsd(balances.reduce((acc, b) => acc + parseUsd(b.value_usd as string), 0n));

  const previous = new Set(input.checkpoint?.firing ?? []);
  const firing: string[] = [];
  const alerts: Alert[] = [];
  for (const t of input.thresholds ?? []) {
    const match = balances.find((b) => b.chain === t.chain && b.address.toLowerCase() === t.address.toLowerCase() && b.asset === assetsById.get(t.asset)?.symbol);
    if (!match) {
      unknowns.push({ kind: "threshold_unevaluated", detail: `no observed balance for threshold on ${t.asset}` });
      continue;
    }
    const cmp = compareBaseUnits(match.base_units, t.base_units);
    const crossed = t.direction === "below" ? cmp < 0 : cmp > 0;
    const key = thresholdKey(t);
    if (!crossed) continue;
    firing.push(key);
    if (previous.has(key)) continue; // still true is not a new crossing
    alerts.push({
      id: key,
      address_label: match.address_label,
      address: match.address,
      chain: match.chain,
      asset: match.asset,
      direction: t.direction,
      threshold_base_units: t.base_units,
      observed_base_units: match.base_units,
      observed_native: match.native,
    });
  }

  return {
    schema: OUTPUT_SCHEMA_ID,
    generated_at: input.now ?? now,
    source_kind: source.kind,
    read_at: [...blocks.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([chain, block_number]) => ({ chain, block_number })),
    balances,
    total_usd,
    alerts,
    unknowns,
    checkpoint: { firing: firing.sort() },
  };
}
