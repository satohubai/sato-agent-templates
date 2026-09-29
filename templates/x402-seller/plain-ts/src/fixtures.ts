// Offline plumbing for fixture mode: a viem transport that answers ONLY from
// recordings in fixtures/rpc.json and throws on anything unrecorded. There is
// no fallback to the network — a missing recording is an error you see.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
