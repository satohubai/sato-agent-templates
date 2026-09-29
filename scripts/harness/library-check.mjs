#!/usr/bin/env node
// Child process for library-shaped sources (AgentKit action providers, the
// Sato Kit). check-actions.mjs spawns it with an environment of PATH and HOME
// only and kills it when its time box runs out.
//
//   node library-check.mjs '<json>'
//     json = { source: "agentkit" | "sato-kit", dir,
//              rpcs: { <evm chain>: fork url }, chains: { <chain>: { kind, chain_id, network, public_rpc } },
//              calls: [{ id, name, chain, provider?, args, wallet_address? }] }
//
// Prints one JSON line: { tools: { <name>: { description, inputSchema,
// outputSchema } }, calls: { <id>: { ok, output } | { ok: false, step, error } } }.
//
// No key is created or loaded. AgentKit is given a READ-ONLY wallet provider
// for the call's chain whose only capabilities are an address to read and a
// public client on that chain's fork (EVM) or a connection to Solana's public
// RPC (SVM); any attempt to send or sign throws.

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
/** One call's time box inside the library child (the child as a whole has its own). */
const CALL_MS = 60_000;
const errMsg = (e) => String(e?.message ?? e).slice(0, 600);

const rpcs = input.rpcs ?? {};
const chains = input.chains ?? {};
const clients = new Map();

async function viemClient(chain = "base") {
  if (!rpcs[chain]) return null;
  if (clients.has(chain)) return clients.get(chain);
  const viem = await load("viem");
  const all = await load("viem/chains");
  const def = Object.values(all).find((c) => c && typeof c === "object" && c.id === chains[chain]?.chain_id) ?? all.base;
  const client = viem.createPublicClient({ chain: def, transport: viem.http(rpcs[chain], { timeout: 30_000, retryCount: 1 }) });
  clients.set(chain, client);
  return client;
}

const refuse = () => { throw new Error("read-only wallet provider: signing and sending are not available in this check"); };

function readOnlyWallet(client, address, chain = "base") {
  const c = chains[chain] ?? { network: "base-mainnet", chain_id: 8453 };
  return {
    getName: () => "sato_status_read_only",
    getAddress: () => address,
    getNetwork: () => ({ protocolFamily: "evm", networkId: c.network, chainId: String(c.chain_id) }),
    getPublicClient: () => client,
    readContract: (p) => client.readContract(p),
    getBalance: () => client.getBalance({ address }),
    sendTransaction: refuse, signMessage: refuse, signTypedData: refuse, signTransaction: refuse, nativeTransfer: refuse,
    waitForTransactionReceipt: refuse,
  };
}

/** Solana: a connection to the public mainnet RPC and an address to read. Nothing can sign. */
async function readOnlySvmWallet(address, chain = "solana") {
  const web3 = await load("@solana/web3.js");
  const c = chains[chain];
  const connection = new web3.Connection(c.public_rpc, { commitment: "confirmed", httpHeaders: { "user-agent": "SatoHub-templates-ci/1.0" } });
  return {
    getName: () => "sato_status_read_only",
    getAddress: () => address,
    getPublicKey: () => new web3.PublicKey(address),
    getNetwork: () => ({ protocolFamily: "svm", networkId: c.network }),
    getConnection: () => connection,
    getBalance: async () => BigInt(await connection.getBalance(new web3.PublicKey(address))),
    signTransaction: refuse, signMessage: refuse, sendTransaction: refuse, signAndSendTransaction: refuse, nativeTransfer: refuse,
    waitForSignatureResult: refuse,
  };
}

async function walletFor(c) {
  if (chains[c.chain]?.kind === "svm") return readOnlySvmWallet(c.wallet_address, c.chain);
  return readOnlyWallet(await viemClient(c.chain ?? "base"), c.wallet_address ?? "0x0000000000000000000000000000000000000001", c.chain ?? "base");
}

async function agentkit() {
  const ak = await load("@coinbase/agentkit");
  const { zodToJsonSchema } = await load("zod-to-json-schema");
  const tools = {};
  const calls = {};
  for (const c of input.calls) {
    try {
      const provider = ak[c.provider]?.();
      if (!provider) { calls[c.id] = { ok: false, step: "tool_missing", error: `${c.provider} is not exported` }; continue; }
      const wallet = await walletFor(c);
      for (const a of provider.getActions(wallet)) {
        if (!tools[a.name]) tools[a.name] = { description: a.description, inputSchema: stripDraft(zodToJsonSchema(a.schema)), outputSchema: null };
      }
      const action = provider.getActions(wallet).find((a) => a.name === c.name);
      if (!action) { calls[c.id] = { ok: false, step: "tool_missing", error: `${c.name} is not among the provider's actions` }; continue; }
      const parsed = action.schema.safeParse(c.args);
      if (!parsed.success) { calls[c.id] = { ok: false, step: "input_rejected", error: errMsg(parsed.error) }; continue; }
      let timer;
      const output = await Promise.race([
        action.invoke(parsed.data),
        new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`timed out after ${CALL_MS / 1000}s`), { step: "timeout" })), CALL_MS); }),
      ]).finally(() => clearTimeout(timer));
      calls[c.id] = { ok: true, output };
    } catch (e) {
      calls[c.id] = { ok: false, step: e?.step === "timeout" ? "timeout" : "call", error: errMsg(e) };
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
  const client = await viemClient("base");
  const actions = kit.coreActions();
  // Catalog actions marked `write` are never passed in (check-actions.mjs).
  // A prepare that is passed in only builds its unsigned payload; nothing
  // here holds a key, signs or sends.
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
    // Solana: the public mainnet RPC (reads only; nothing here can sign).
    solanaRpc: (chain) => {
      if (chain !== "solana" || !chains.solana?.public_rpc) throw new Error(`no public RPC for ${chain}`);
      return kit.solanaJsonRpc(chains.solana.public_rpc, { userAgent: "SatoHub-templates-ci/1.0", fetch: ctx.fetch });
    },
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
