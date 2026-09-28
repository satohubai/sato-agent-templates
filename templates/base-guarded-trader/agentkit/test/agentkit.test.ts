// The AgentKit wiring: the kit's action provider is the only source of tools,
// execute is refused without an approve callback (fixture and fork), a "no"
// from the callback stops it, and fixture mode's wallet provider holds no key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRuntime } from "../src/runtime.js";
import { loadPolicy } from "../src/policy.js";
import { buildAgentKit, TOOLS } from "../src/agentkit.js";
import { MockModel } from "../src/model.js";
import { parseConfig } from "../src/config.js";

const policy = loadPolicy("policy.json");
const fixture = () => buildRuntime({ mode: "fixture", policy, fixturesDir: "fixtures", env: {} });
const INTENT = { intent_id: "si_" + "A".repeat(43) };

test("AgentKit exposes the kit's tools, including the four this template calls", async () => {
  const rt = await fixture();
  const ak = await buildAgentKit({ kit: rt.kit, walletProvider: rt.walletProvider, policy, signerKind: null });
  const names = ak.actions.map((a) => a.name);
  for (const t of Object.values(TOOLS)) assert.ok(names.some((n) => n === t || n.endsWith(`_${t}`)), `${t} in ${names.join(",")}`);
  const exec = ak.actions.find((a) => a.name.endsWith("execute"))!;
  assert.match(exec.description, /approval/i);
});

test("without an approve callback the provider refuses execute (fixture and fork)", async () => {
  const rt = await fixture();
  const ak = await buildAgentKit({ kit: rt.kit, walletProvider: rt.walletProvider, policy, signerKind: null });
  const env = await ak.call(TOOLS.execute, INTENT);
  assert.equal(env.ok, false);
  assert.equal(!env.ok && env.error.code, "approval_required");
});

test("an approve callback that answers no stops execute before the kit sees it", async () => {
  const rt = await fixture();
  const seen: string[] = [];
  const ak = await buildAgentKit({
    kit: rt.kit, walletProvider: rt.walletProvider, policy, signerKind: null,
    approve: async (summary) => { seen.push(summary); return false; },
  });
  const env = await ak.call(TOOLS.execute, INTENT);
  assert.equal(!env.ok && env.error.code, "approval_denied");
  assert.equal(seen.length, 1);
  assert.match(seen[0], /execute/);
});

test("the over-cap swap_prepare comes back refused with rule, limit and observed, and the intent attached", async () => {
  const rt = await fixture();
  rt.usd.eth_usd = 2695.0463635;
  const ak = await buildAgentKit({ kit: rt.kit, walletProvider: rt.walletProvider, policy, signerKind: null });
  const env = await ak.call(TOOLS.swapPrepare, {
    chain: "base",
    sell_token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    buy_token: "0x4200000000000000000000000000000000000006",
    sell_amount: "1000000000",
    slippage_bps: 50,
    venue: "sato",
    taker: rt.taker,
  });
  assert.equal(env.ok, false);
  if (env.ok) return;
  assert.equal(env.error.code, "policy_refused");
  const r = env.error.refusals!.find((x) => x.rule === "max_usd_per_trade")!;
  assert.equal(r.limit, "25");
  assert.equal(r.observed, "1000");
  assert.ok(env.intent?.intent_id.startsWith("si_"));
});

test("the fixture wallet provider holds no key: it cannot send", async () => {
  const rt = await fixture();
  assert.equal(rt.signer, null);
  assert.equal(rt.walletProvider.getNetwork().networkId, "base-mainnet");
  await assert.rejects(rt.walletProvider.nativeTransfer("0x000000000000000000000000000000000000dEaD", "1"), /no key/);
});

test("the mock model never asks for execute", () => {
  const cfg = parseConfig({});
  const m = new MockModel();
  const ideas = m.decide({ block: "1", gas_price_gwei: "1", eth_usd: 2000 }, cfg);
  for (const idea of ideas) {
    const calls = m.toolCalls(idea, { chain: "base", sell_token: "a", buy_token: "b", sell_amount: "1", slippage_bps: 50, venue: "sato" });
    assert.deepEqual(calls.map((c) => c.name), [TOOLS.swapQuote, TOOLS.swapPrepare]);
  }
});

test("testnet refuses to start without the CDP smart wallet variables", async () => {
  await assert.rejects(
    buildRuntime({ mode: "testnet", policy, fixturesDir: "fixtures", env: { BASE_SEPOLIA_RPC_URL: "http://127.0.0.1:1" } }),
    /CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET/,
  );
});

test("a fixture run builds AgentKit and calls its actions without touching the network (no AgentKit analytics)", async () => {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (u: unknown) => {
    calls.push(String(u));
    throw new Error("network is off in this test");
  }) as typeof fetch;
  try {
    const rt = await fixture();
    const ak = await buildAgentKit({ kit: rt.kit, walletProvider: rt.walletProvider, policy, signerKind: null });
    await ak.call(TOOLS.execute, INTENT);
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(calls, []);
});
