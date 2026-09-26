// Offline plumbing for fixture mode: a viem transport and a fetch that answer
// ONLY from recordings in fixtures/, and throw on anything unrecorded. There
// is no fallback to the network — a missing recording is an error you see.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { custom, http, type Transport } from "viem";

// ── RPC ──────────────────────────────────────────────────────────────────────

export type RpcFixtures = Record<string, unknown>;

type Call = { to?: string; data?: string; input?: string; from?: string };

/**
 * The lookup key for one JSON-RPC request. Contract reads and gas estimates key
 * on (to, calldata) and ignore the block tag, so a recording made at the pinned
 * block answers however the caller names that block.
 */
export function rpcKey(method: string, params: unknown): string {
  const p = Array.isArray(params) ? params : [];
  if (method === "eth_call" || method === "eth_estimateGas") {
    const c = (p[0] ?? {}) as Call;
    return `${method} ${String(c.to ?? "").toLowerCase()} ${String(c.data ?? c.input ?? "").toLowerCase()}`;
  }
  if (method === "eth_chainId" || method === "eth_blockNumber" || method === "eth_gasPrice" || method === "eth_maxPriorityFeePerGas") return method;
  return `${method} ${JSON.stringify(p)}`;
}

export function loadRpcFixtures(dir: string): RpcFixtures {
  const file = join(dir, "rpc.json");
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { calls?: RpcFixtures };
  return parsed.calls ?? {};
}

export function fixtureTransport(fixtures: RpcFixtures): Transport {
  return custom(
    {
      async request({ method, params }: { method: string; params?: unknown }) {
        const key = rpcKey(method, params);
        if (!(key in fixtures)) throw new Error(`fixture mode: no recorded RPC answer for ${key} (fixture mode never uses the network)`);
        return fixtures[key];
      },
    },
    { retryCount: 0 },
  );
}

/** fork --record: pass calls through to the fork and keep every answer. */
export function recordingTransport(url: string, sink: RpcFixtures): Transport {
  const inner = http(url, { timeout: 30_000 });
  return (opts) => {
    const t = inner(opts);
    return {
      ...t,
      async request(args: { method: string; params?: unknown }) {
        const result = await t.request(args as never);
        if (!args.method.startsWith("anvil_")) sink[rpcKey(args.method, args.params)] = result;
        return result;
      },
    } as ReturnType<Transport>;
  };
}

export function writeRpcFixtures(dir: string, calls: RpcFixtures, meta: Record<string, unknown>): void {
  const merged = { ...loadRpcFixtures(dir), ...calls };
  const sorted = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  writeFileSync(join(dir, "rpc.json"), JSON.stringify({ ...meta, calls: sorted }, null, 2) + "\n");
}

// ── HTTP (venue quotes) ──────────────────────────────────────────────────────

export type HttpFixture = {
  request: { method: string; url: string; body?: unknown };
  response: { status: number; headers?: Record<string, string>; body: unknown };
  recorded_at?: string;
  note?: string;
};

/** Fields that name who is asking, not what is asked. A recording answers for any taker. */
const WHO = new Set(["taker", "fromAddress"]);

/**
 * The lookup key for one venue request: method, origin + path, and every query
 * parameter and JSON body field except the taker, sorted. So a quote recorded
 * for one address answers the same quote asked for another, and a different
 * amount, pair, slippage or mode never matches.
 */
export function httpKey(method: string, url: string, body: unknown): string {
  const u = new URL(url);
  const q = [...u.searchParams.entries()].filter(([k]) => !WHO.has(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const b = body && typeof body === "object" && !Array.isArray(body)
    ? Object.entries(body as Record<string, unknown>).filter(([k]) => !WHO.has(k)).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    : body ?? null;
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

async function describe(input: RequestInfo | URL, init?: RequestInit): Promise<Req> {
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
    const r = await describe(input, init);
    const hit = map.get(httpKey(r.method, r.url, r.body));
    if (!hit) {
      const u = new URL(r.url);
      throw new TypeError(`fixture mode: no recorded response for ${r.method} ${u.origin}${u.pathname} (fixture mode never uses the network)`);
    }
    const body = typeof hit.response.body === "string" ? hit.response.body : JSON.stringify(hit.response.body);
    return new Response(body, { status: hit.response.status, headers: { "content-type": "application/json", ...(hit.response.headers ?? {}) } });
  }) as typeof fetch;
}

/** fork --record: pass venue requests through to the network and keep each request and answer. */
export function recordingFetch(inner: typeof fetch, sink: HttpFixture[], clock: () => string = () => new Date().toISOString()): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = await describe(input, init);
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

/** File name for one recording: host, last path segment, mode (when the body names one) and amount. */
export function httpFixtureName(f: HttpFixture): string {
  const u = new URL(f.request.url);
  const b = (f.request.body ?? {}) as Record<string, unknown>;
  const host = u.hostname.replace(/^(www|api)\./, "").split(".")[0];
  const seg = u.pathname.split("/").filter(Boolean).pop() ?? "root";
  const mode = typeof b.mode === "string" ? `-${b.mode}` : "";
  const amount = String(b.amount_in ?? u.searchParams.get("fromAmount") ?? u.searchParams.get("sellAmount") ?? "x");
  return `${host}-${seg}${mode}-${amount}.json`;
}

export function writeHttpFixtures(dir: string, recs: HttpFixture[]): string[] {
  const d = join(dir, "http");
  mkdirSync(d, { recursive: true });
  for (const f of readdirSync(d).filter((x) => x.endsWith(".json"))) rmSync(join(d, f));
  const names: string[] = [];
  for (const f of recs) {
    const name = httpFixtureName(f);
    writeFileSync(join(d, name), JSON.stringify(f, null, 2) + "\n");
    names.push(name);
  }
  return names;
}

// ── kit FixtureSource ────────────────────────────────────────────────────────

/** fixtures/kit/<key>.json, keyed by the action's own fixture names. */
export function kitFixtureSource(dir: string): { get(key: string): unknown | undefined } {
  const d = join(dir, "kit");
  const map = new Map<string, unknown>();
  if (existsSync(d)) {
    for (const f of readdirSync(d).filter((x) => x.endsWith(".json"))) map.set(f.slice(0, -5), JSON.parse(readFileSync(join(d, f), "utf8")));
  }
  return { get: (key: string) => map.get(key) };
}
