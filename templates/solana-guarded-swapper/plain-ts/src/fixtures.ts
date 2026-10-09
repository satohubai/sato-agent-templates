// Offline plumbing for fixture mode: a Solana JSON-RPC and a fetch that answer
// ONLY from recordings in fixtures/, and throw on anything unrecorded. There is
// no fallback to the network: a missing recording is an error you see.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SolanaRpc } from "@satohub/kit";

// ── Solana RPC ───────────────────────────────────────────────────────────────

export type RpcFixtures = Record<string, unknown>;

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/**
 * The lookup key for one JSON-RPC request: the method and its params. The
 * transaction in a simulateTransaction call is long, so it is keyed by the
 * first 16 hex characters of its sha256.
 */
export function rpcKey(method: string, params: unknown): string {
  const p = Array.isArray(params) ? params : [];
  if (method === "simulateTransaction" && typeof p[0] === "string") return `${method} tx:${sha(p[0])} ${JSON.stringify(p.slice(1))}`;
  return `${method} ${JSON.stringify(p)}`;
}

export function loadRpcFixtures(dir: string): RpcFixtures {
  const file = join(dir, "rpc.json");
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { calls?: RpcFixtures };
  return parsed.calls ?? {};
}

export function fixtureSolanaRpc(fixtures: RpcFixtures): SolanaRpc {
  return {
    async request(method: string, params: readonly unknown[]) {
      const key = rpcKey(method, params);
      if (!(key in fixtures)) throw new Error(`fixture mode: no recorded Solana RPC answer for ${key.length > 160 ? `${key.slice(0, 160)}…` : key} (fixture mode never uses the network)`);
      return fixtures[key];
    },
  };
}

/** --record: pass calls through to the RPC and keep every answer. */
export function recordingSolanaRpc(inner: SolanaRpc, sink: RpcFixtures): SolanaRpc {
  return {
    async request(method: string, params: readonly unknown[]) {
      const result = await inner.request(method, params);
      sink[rpcKey(method, params)] = result;
      return result;
    },
  };
}

export function writeRpcFixtures(dir: string, calls: RpcFixtures, meta: Record<string, unknown>): void {
  const sorted = Object.fromEntries(Object.entries(calls).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  writeFileSync(join(dir, "rpc.json"), JSON.stringify({ ...meta, calls: sorted }, null, 2) + "\n");
}

// ── HTTP (venue quotes and the swap transaction) ─────────────────────────────

export type HttpFixture = {
  request: { method: string; url: string; body?: unknown };
  response: { status: number; headers?: Record<string, string>; body: unknown };
  recorded_at?: string;
  note?: string;
};

/** Fields that name who is asking, not what is asked. A recording answers for any wallet. */
const WHO = new Set(["taker", "userPublicKey"]);

/**
 * The lookup key for one venue request: method, origin + path, and every query
 * parameter and JSON body field except the wallet, sorted. A different amount,
 * pair, slippage or fee never matches.
 */
export function httpKey(method: string, url: string, body: unknown): string {
  const u = new URL(url);
  const q = [...u.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const b =
    body && typeof body === "object" && !Array.isArray(body)
      ? Object.entries(body as Record<string, unknown>)
          .filter(([k]) => !WHO.has(k))
          .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
      : (body ?? null);
  return `${method.toUpperCase()} ${u.origin}${u.pathname} ${JSON.stringify(q)} ${JSON.stringify(b)}`;
}

export function loadHttpFixtures(dir: string): HttpFixture[] {
  const d = join(dir, "http");
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(d, f), "utf8")) as HttpFixture);
}

type Req = { method: string; url: string; body: unknown };

function describe(input: RequestInfo | URL, init?: RequestInit): Req {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const raw = typeof init?.body === "string" ? init.body : null;
  let body: unknown = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }
  return { method, url, body };
}

/** Answers only recorded requests (see httpKey). Anything else throws; there is no network fallback. */
export function fixtureFetch(fixtures: HttpFixture[]): typeof fetch {
  const map = new Map(fixtures.map((f) => [httpKey(f.request.method, f.request.url, f.request.body ?? null), f]));
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = describe(input, init);
    const hit = map.get(httpKey(r.method, r.url, r.body));
    if (!hit) {
      const u = new URL(r.url);
      throw new TypeError(`fixture mode: no recorded response for ${r.method} ${u.origin}${u.pathname} (fixture mode never uses the network)`);
    }
    const body = typeof hit.response.body === "string" ? hit.response.body : JSON.stringify(hit.response.body);
    return new Response(body, { status: hit.response.status, headers: { "content-type": "application/json", ...(hit.response.headers ?? {}) } });
  }) as typeof fetch;
}

/** --record: pass venue requests through to the network and keep each request and answer. */
export function recordingFetch(inner: typeof fetch, sink: HttpFixture[], clock: () => string = () => new Date().toISOString()): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = describe(input, init);
    const res = await inner(input, init);
    const text = await res.clone().text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep text */
    }
    sink.push({ request: { method: r.method, url: r.url, ...(r.body !== null ? { body: r.body } : {}) }, response: { status: res.status, body }, recorded_at: clock() });
    return res;
  }) as typeof fetch;
}

/** File name for one recording: host, last path segment, the amount, and the fee when the request carries one. */
export function httpFixtureName(f: HttpFixture): string {
  const u = new URL(f.request.url);
  const b = (f.request.body ?? {}) as Record<string, unknown>;
  const quote = (b.quoteResponse ?? {}) as Record<string, unknown>;
  const host = u.hostname.replace(/^(www|api|lite-api)\./, "").split(".")[0];
  const seg = u.pathname.split("/").filter(Boolean).pop() ?? "root";
  const amount = String(b.amount_in ?? quote.inAmount ?? u.searchParams.get("amount") ?? "x");
  const bps = u.searchParams.get("platformFeeBps");
  const fee = bps ? `-fee${bps}` : b.feeAccount ? "-feeacct" : "";
  return `${host}-${seg}-${amount}${fee}.json`;
}

export function writeHttpFixtures(dir: string, recs: HttpFixture[]): string[] {
  const d = join(dir, "http");
  mkdirSync(d, { recursive: true });
  for (const f of readdirSync(d).filter((x) => x.endsWith(".json"))) rmSync(join(d, f));
  const names: string[] = [];
  for (const f of recs) {
    const name = httpFixtureName(f);
    if (names.includes(name)) continue; // the same request asked twice records once
    writeFileSync(join(d, name), JSON.stringify(f, null, 2) + "\n");
    names.push(name);
  }
  return names;
}
