// Offline plumbing for fixture mode: a viem transport and a fetch that answer
// ONLY from recordings in fixtures/, and throw on anything unrecorded. There
// is no fallback to the network — a missing recording is an error you see.

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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
        sink[rpcKey(args.method, args.params)] = result;
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
  request: { method: string; url: string };
  response: { status: number; headers?: Record<string, string>; body: unknown };
  recorded_at?: string;
  note?: string;
};

export function loadHttpFixtures(dir: string): HttpFixture[] {
  const d = join(dir, "http");
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(d, f), "utf8")) as HttpFixture);
}

/** Exact URL first, then the same origin + path with any query. Anything else throws. */
export function fixtureFetch(fixtures: HttpFixture[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const same = (f: HttpFixture) => f.request.method.toUpperCase() === method;
    const exact = fixtures.find((f) => same(f) && f.request.url === url.href);
    const byPath = fixtures.find((f) => {
      const u = new URL(f.request.url);
      return same(f) && u.origin === url.origin && u.pathname === url.pathname && u.searchParams.get("amount") === url.searchParams.get("amount");
    });
    const loose = fixtures.find((f) => {
      const u = new URL(f.request.url);
      return same(f) && u.origin === url.origin && u.pathname === url.pathname;
    });
    const hit = exact ?? byPath ?? loose;
    if (!hit) throw new TypeError(`fixture mode: no recorded response for ${method} ${url.origin}${url.pathname} (fixture mode never uses the network)`);
    const body = typeof hit.response.body === "string" ? hit.response.body : JSON.stringify(hit.response.body);
    return new Response(body, { status: hit.response.status, headers: { "content-type": "application/json", ...(hit.response.headers ?? {}) } });
  }) as typeof fetch;
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
