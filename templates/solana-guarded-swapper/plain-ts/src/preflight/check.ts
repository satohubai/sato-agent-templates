// Puts the pieces together: hash what is installed, look up its receipt, and
// say whether the two describe the same build. No output formatting here.

import { readReceiptFromApi } from "./api.js";
import { readReceiptsFromChain, SAS_PROGRAM_ID, type SubjectKey } from "./sas.js";
import type { BuildStatus, Cluster, Fetch, JsonRpc, Receipt, ReceiptSource, Row, Subject } from "./types.js";
import { digestInstalled, USER_AGENT } from "./tarball.js";

export type ReceiptsConfig = {
  cluster: Cluster;
  credential: string | null;
  receipt_schema: string | null;
  rpc_url: string | null;
  api_url: string | null;
  watch: string[];
};

export const DEFAULT_RPC: Record<Cluster, string> = {
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
};

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export class ConfigError extends Error {}

export function parseReceiptsConfig(input: unknown): ReceiptsConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new ConfigError("receipts.config.json must be a JSON object");
  const c = input as Record<string, unknown>;
  const allowed = ["schema", "cluster", "credential", "receipt_schema", "rpc_url", "api_url", "watch"];
  for (const k of Object.keys(c)) if (!allowed.includes(k)) throw new ConfigError(`receipts.config.json: unknown property ${JSON.stringify(k)}`);
  if (c.schema !== "sato.template-receipts/v1") throw new ConfigError('receipts.config.json: "schema" must be "sato.template-receipts/v1"');
  const cluster = c.cluster ?? "mainnet-beta";
  if (cluster !== "mainnet-beta" && cluster !== "devnet") throw new ConfigError('receipts.config.json: "cluster" must be "mainnet-beta" or "devnet"');
  const addr = (k: "credential" | "receipt_schema"): string | null => {
    const v = c[k];
    if (v === null || v === undefined) return null;
    if (typeof v !== "string" || !BASE58.test(v)) throw new ConfigError(`receipts.config.json: "${k}" must be a base58 Solana address or null`);
    return v;
  };
  const url = (k: "rpc_url" | "api_url"): string | null => {
    const v = c[k];
    if (v === null || v === undefined) return null;
    if (typeof v !== "string") throw new ConfigError(`receipts.config.json: "${k}" must be an https URL or null`);
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      throw new ConfigError(`receipts.config.json: "${k}" must be an https URL or null`);
    }
    if (u.protocol !== "https:") throw new ConfigError(`receipts.config.json: "${k}" must be an https URL or null`);
    return v;
  };
  const watch = c.watch ?? [];
  if (!Array.isArray(watch) || !watch.every((w) => typeof w === "string" && w.length > 0)) throw new ConfigError('receipts.config.json: "watch" must be a list of package names');
  const credential = addr("credential");
  const receipt_schema = addr("receipt_schema");
  if ((credential === null) !== (receipt_schema === null)) throw new ConfigError('receipts.config.json: set "credential" and "receipt_schema" together, or neither');
  return { cluster, credential, receipt_schema, rpc_url: url("rpc_url"), api_url: url("api_url"), watch: [...watch] as string[] };
}

export const chainConfigured = (c: ReceiptsConfig): boolean => c.credential !== null && c.receipt_schema !== null;

/** A JSON-RPC caller over fetch. Read methods only are ever sent by this module. */
export function jsonRpcOverFetch(url: string, fetchImpl: Fetch, timeoutMs = 20_000): JsonRpc {
  let id = 0;
  return async (method, params) => {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": USER_AGENT },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${new URL(url).host} answered HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message ?? "RPC error"}`);
    return body.result;
  };
}

/** Pure: how an installed digest and a receipt relate. */
export function matchBuild(receipt: Receipt | null, installedDigestHex: string): "same_build" | "different_build" | "no_receipt" {
  if (!receipt) return "no_receipt";
  const norm = (h: string) => h.toLowerCase().replace(/^0x/, "");
  return norm(receipt.digest_hex) === norm(installedDigestHex) ? "same_build" : "different_build";
}

async function pool<T, R>(items: readonly T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export type SourceMode = "auto" | "chain" | "api";

export type PreflightReport = {
  /** Plain sentence saying where the receipts were read from, and why. */
  source_note: string;
  /** Which sources actually answered, for the rows that were looked up. */
  sources_used: ReceiptSource[];
  cluster: Cluster;
  rows: Row[];
};

export type RunOptions = {
  subjects: readonly Subject[];
  config: ReceiptsConfig;
  fetch: Fetch;
  projectDir: string;
  source?: SourceMode;
  /** Injected in tests; otherwise built from rpc_url / SATO_RECEIPTS_RPC_URL / the cluster default. */
  rpc?: JsonRpc;
  rpcUrlEnv?: string | null;
  concurrency?: number;
  now?: () => number;
};

export async function runPreflight(o: RunOptions): Promise<PreflightReport> {
  const mode = o.source ?? "auto";
  const conc = o.concurrency ?? 6;
  const cfg = o.config;

  const digests = await pool(o.subjects, conc, (s) => digestInstalled(s, { fetch: o.fetch, projectDir: o.projectDir }));

  // Receipts: chain first when configured, the API for what the chain could not answer.
  const key = (s: SubjectKey) => `${s.subject_id}@${s.version}`;
  const keys: SubjectKey[] = [...new Map(o.subjects.map((s) => [key(s), { subject_id: s.subject_id, version: s.version }])).values()];
  const found = new Map<string, { receipt: Receipt | null; source: ReceiptSource } | { error: string }>();
  const notes: string[] = [];

  const wantChain = mode !== "api";
  let chainTried = false;
  if (wantChain && chainConfigured(cfg)) {
    chainTried = true;
    const url = o.rpcUrlEnv ?? cfg.rpc_url ?? DEFAULT_RPC[cfg.cluster];
    const rpc = o.rpc ?? jsonRpcOverFetch(url, o.fetch);
    const res = await readReceiptsFromChain(rpc, { cluster: cfg.cluster, credential: cfg.credential!, schema: cfg.receipt_schema! }, keys, o.now);
    for (const k of keys) {
      const r = res.get(key(k));
      if (r?.ok) found.set(key(k), { receipt: r.receipt, source: "chain" });
      else found.set(key(k), { error: r?.error ?? "no answer" });
    }
    const failed = keys.filter((k) => "error" in (found.get(key(k)) ?? { error: "" }));
    notes.push(
      failed.length === 0
        ? `Read from Solana ${cfg.cluster} (SAS program ${SAS_PROGRAM_ID.slice(0, 4)}…${SAS_PROGRAM_ID.slice(-4)}) with no key and no call to Sato Hub, through ${new URL(url).host}.`
        : `Read from Solana ${cfg.cluster} through ${new URL(url).host}; ${failed.length} of ${keys.length} could not be read from chain (${(found.get(key(failed[0])) as { error: string }).error}).`,
    );
  } else if (mode === "chain") {
    notes.push("Chain read requested, but receipts.config.json has no credential and receipt_schema yet, so nothing was read.");
  } else if (!chainConfigured(cfg)) {
    notes.push("Not read from chain: the Sato Hub credential and receipt schema addresses are not set in receipts.config.json yet.");
  }

  const needApi = mode !== "chain" && cfg.api_url !== null ? keys.filter((k) => !("receipt" in (found.get(key(k)) ?? {}))) : [];
  if (needApi.length > 0) {
    const results = await pool(needApi, conc, (k) => readReceiptFromApi(o.fetch, cfg.api_url!, k.subject_id, k.version));
    needApi.forEach((k, i) => {
      const r = results[i];
      if (r.ok) found.set(key(k), { receipt: r.receipt, source: "api" });
      else if (!("receipt" in (found.get(key(k)) ?? {}))) found.set(key(k), { error: r.error });
    });
    const apiHost = new URL(cfg.api_url!).host;
    notes.push(`${chainTried ? "For the rest, read" : "Read"} from the Sato Hub API (${apiHost}); that is one call to a Sato Hub server, not a read of the chain.`);
  }

  const rows: Row[] = o.subjects.map((s, i) => {
    const d = digests[i];
    const f = found.get(key(s));
    const lookup = f && "receipt" in f ? f : null;
    const base = { subject: s, receipt: lookup?.receipt ?? null, source: lookup?.source ?? null };
    if (!d.ok) {
      return { ...base, status: (d.reason === "lock_mismatch" ? "lock_mismatch" : "unchecked") as BuildStatus, detail: d.detail, installed_digest_hex: null };
    }
    if (!lookup) return { ...base, status: "unchecked" as BuildStatus, detail: f && "error" in f ? `no receipt source answered: ${f.error}` : "no receipt source is available", installed_digest_hex: d.digest_hex };
    return { ...base, status: matchBuild(lookup.receipt, d.digest_hex) as BuildStatus, detail: null, installed_digest_hex: d.digest_hex };
  });

  return {
    source_note: notes.join(" "),
    sources_used: [...new Set(rows.map((r) => r.source).filter((x): x is ReceiptSource => x !== null))],
    cluster: cfg.cluster,
    rows,
  };
}

export type Counts = Record<BuildStatus, number>;

export function countStatuses(rows: readonly Row[]): Counts {
  const c: Counts = { same_build: 0, different_build: 0, no_receipt: 0, lock_mismatch: 0, unchecked: 0 };
  for (const r of rows) c[r.status]++;
  return c;
}

/** Why --strict would exit 1, empty when it would not. `requireReading` also counts "no reading" and "could not check". */
export function strictFailures(rows: readonly Row[], requireReading: boolean): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const id = `${r.subject.name}@${r.subject.version}`;
    if (r.status === "different_build") out.push(`${id}: the installed build differs from the one the reading was recorded for`);
    else if (r.status === "lock_mismatch") out.push(`${id}: the tarball does not match package-lock.json`);
    else if (r.receipt?.key_egress === "observed") out.push(`${id}: Sato Check observed a planted test key leave (see its reading)`);
    else if (requireReading && r.status === "no_receipt") out.push(`${id}: no reading for this version`);
    else if (requireReading && r.status === "unchecked") out.push(`${id}: could not be checked${r.detail ? ` (${r.detail})` : ""}`);
  }
  return out;
}
