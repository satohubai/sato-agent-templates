#!/usr/bin/env node
// Child process for library-shaped sources (AgentKit action providers, the
// Sato Kit). check-actions.mjs spawns it with an environment of PATH and HOME
// only and kills it when its time box runs out.
//
//   node library-check.mjs '<json>'
//     json = { source: "agentkit" | "sato-kit", dir, rpc: url|null,
//              calls: [{ id, name, provider?, args, wallet_address? }] }
//
// Prints one JSON line: { tools: { <name>: { description, inputSchema,
// outputSchema } }, calls: { <id>: { ok, output } | { ok: false, step, error } } }.
//
// No key is created or loaded. AgentKit is given a READ-ONLY wallet provider
// whose only capabilities are an address to read and a public client on the
// fork; any attempt to send or sign throws.

import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const input = JSON.parse(process.argv[2]);

// AgentKit posts a usage event to its analytics host on every action call.
// That event is not part of what the action does, so the check answers it
// locally (204) instead of sending it; nothing else is intercepted.
const ANALYTICS_HOSTS = new Set(["cca-lite.coinbase.com"]);
const realFetch = globalThis.fetch;
globalThis.fetch = (u, init) => {
  try {
    if (ANALYTICS_HOSTS.has(new URL(typeof u === "string" ? u : u.url).host)) return Promise.resolve(new Response(null, { status: 204 }));
  } catch { /* not a URL we can read: pass it through */ }
  return realFetch(u, init);
};
const req = createRequire(join(input.dir, "package.json"));
const load = async (spec) => import(pathToFileURL(req.resolve(spec)).href);
const errMsg = (e) => String(e?.message ?? e).slice(0, 600);

async function viemClient() {
  const viem = await load("viem");
  const { base } = await load("viem/chains");
  return viem.createPublicClient({ chain: base, transport: viem.http(input.rpc ?? "http://127.0.0.1:8547", { timeout: 30_000, retryCount: 1 }) });
}

function readOnlyWallet(client, address) {
  const refuse = () => { throw new Error("read-only wallet provider: signing and sending are not available in this check"); };
  return {
    getName: () => "sato_status_read_only",
    getAddress: () => address,
    getNetwork: () => ({ protocolFamily: "evm", networkId: "base-mainnet", chainId: "8453" }),
    getPublicClient: () => client,
    readContract: (p) => client.readContract(p),
    getBalance: () => client.getBalance({ address }),
    sendTransaction: refuse, signMessage: refuse, signTypedData: refuse, signTransaction: refuse, nativeTransfer: refuse,
    waitForTransactionReceipt: refuse,
  };
}

async function agentkit() {
  const ak = await load("@coinbase/agentkit");
  const { zodToJsonSchema } = await load("zod-to-json-schema");
  const client = input.rpc ? await viemClient() : null;
  const tools = {};
  const calls = {};
  for (const c of input.calls) {
    try {
      const provider = ak[c.provider]?.();
      if (!provider) { calls[c.id] = { ok: false, step: "tool_missing", error: `${c.provider} is not exported` }; continue; }
      const wallet = readOnlyWallet(client, c.wallet_address ?? "0x0000000000000000000000000000000000000001");
      for (const a of provider.getActions(wallet)) {
        if (!tools[a.name]) tools[a.name] = { description: a.description, inputSchema: stripDraft(zodToJsonSchema(a.schema)), outputSchema: null };
      }
      const action = provider.getActions(wallet).find((a) => a.name === c.name);
      if (!action) { calls[c.id] = { ok: false, step: "tool_missing", error: `${c.name} is not among the provider's actions` }; continue; }
      const parsed = action.schema.safeParse(c.args);
      if (!parsed.success) { calls[c.id] = { ok: false, step: "input_rejected", error: errMsg(parsed.error) }; continue; }
      const output = await action.invoke(parsed.data);
      calls[c.id] = { ok: true, output };
    } catch (e) {
      calls[c.id] = { ok: false, step: "call", error: errMsg(e) };
    }
  }
  return { tools, calls };
}

function stripDraft(s) {
  if (s && typeof s === "object") { const { $schema, ...rest } = s; return rest; }
  return s;
}

async function satoKit() {
  const kit = await load("@satohub/kit");
  const client = input.rpc ? await viemClient() : null;
  const actions = kit.coreActions();
  const tools = {};
  for (const a of actions) tools[a.descriptor.name] = { description: a.descriptor.description, inputSchema: a.descriptor.input_schema, outputSchema: a.descriptor.output_schema };
  const policy = {
    schema: "sato.policy/v1", version: 1, network: "fork", allow_chains: ["base"], allow_tokens: [], allow_contracts: [], allow_recipients: [],
    allow_venues: [], max_usd_per_trade: 25, max_usd_per_day: 100, max_per_trade: {}, max_slippage_bps: 100, intent_ttl_s: 300,
    unknown_verdict: "refuse", require_simulation: true, human_approval: false,
  };
  const ctx = {
    fetch: (u, init = {}) => fetch(u, { ...init, headers: { ...(init.headers ?? {}), "user-agent": "SatoHub-templates-ci/1.0" }, signal: init.signal ?? AbortSignal.timeout(30_000) }),
    clock: () => Date.now(),
    rpc: () => { if (!client) throw new Error("no fork RPC given"); return client; },
    policy,
    userAgent: "SatoHub-templates-ci/1.0",
  };
  const calls = {};
  for (const c of input.calls) {
    const a = actions.find((x) => x.descriptor.name === c.name);
    if (!a) { calls[c.id] = { ok: false, step: "tool_missing", error: `${c.name} is not a core action` }; continue; }
    try {
      const out = typeof a.run === "function" ? await a.run(c.args, ctx) : await a.build(c.args, ctx);
      calls[c.id] = { ok: true, output: JSON.parse(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) };
    } catch (e) {
      calls[c.id] = { ok: false, step: "call", error: errMsg(e) };
    }
  }
  return { tools, calls };
}

const out = input.source === "agentkit" ? await agentkit() : await satoKit();
process.stdout.write(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n");
process.exit(0);
