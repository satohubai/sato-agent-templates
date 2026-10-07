// The OpenAI Agents SDK wiring: the kit's function tools, the runner's approval
// interruptions, the scripted Model fixture mode uses, and live-mode guards.
// Nothing here calls a model API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "viem";
import { buildRuntime, type Runtime } from "../src/runtime.js";
import { loadPolicy } from "../src/policy.js";
import { approvalTools, buildHost, envelopeOf, runAgent, ScriptedModel, type Approver } from "../src/host.js";
import { liveModel, runLive } from "../src/live.js";
import { DEFAULT_MODEL_ID } from "../src/config.js";
import { MockModel, scriptedNext } from "../src/model.js";
import { TOKENS } from "../src/tokens.js";
import { recordingsPolicy } from "./goal-bound.js";

// These tests replay the recordings' 10 USDC trade; see recordingsPolicy() in goal-bound.ts.
const RECORDINGS_POLICY = recordingsPolicy();

async function fixtureRuntime(): Promise<Runtime> {
  const rt = await buildRuntime({ mode: "fixture", policy: loadPolicy(RECORDINGS_POLICY), fixturesDir: "fixtures", env: {} });
  rt.usd.eth_usd = 2695.0463635;
  return rt;
}

function swap(rt: Runtime, amount: string) {
  return {
    chain: rt.chain,
    sell_token: TOKENS.base.USDC.address,
    buy_token: TOKENS.base.WETH.address,
    sell_amount: parseUnits(amount, 6).toString(),
    slippage_bps: 50,
    venue: "sato",
    taker: rt.taker,
  };
}

/** Fails the test if anything tries the network (a model API, tracing export). */
function noNetwork(): () => void {
  const saved = globalThis.fetch;
  globalThis.fetch = (async (u: unknown) => {
    throw new Error(`network call attempted: ${String(u)}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = saved;
  };
}

test("the tools are the kit's function tools, with valid OpenAI names", async () => {
  const host = buildHost(await fixtureRuntime());
  const names = host.tools.map((t) => t.name);
  for (const n of ["chain_read", "swap_quote", "swap_prepare", "execute"]) assert.ok(names.includes(n), n);
  assert.ok(host.tools.every((t) => t.type === "function" && /^[a-zA-Z0-9_-]{1,64}$/.test(t.name)));
});

test("needsApproval is set on swap_prepare and execute, and not on reads or quotes", async () => {
  const gated = await approvalTools(buildHost(await fixtureRuntime()));
  for (const t of ["swap_prepare", "execute"]) assert.ok(gated.includes(t), t);
  for (const t of ["swap_quote", "chain_read", "actions_search"]) assert.ok(!gated.includes(t), t);
});

test("execute refuses any key besides intent_id", async () => {
  const host = buildHost(await fixtureRuntime());
  const exec = host.tools.find((t) => t.name === "execute")!;
  const out = await exec.invoke({} as never, JSON.stringify({ intent_id: "si_" + "A".repeat(43), to: "0xattacker" }));
  const env = envelopeOf(out);
  assert.ok(env && !env.ok);
});

test("the runner with the scripted model quotes, prepares, refuses the over-cap intent by name, and never runs execute", async () => {
  const restore = noNetwork();
  try {
    const rt = await fixtureRuntime();
    const host = buildHost(rt);
    const cfg = { venue: "sato" as const, amount_usdc: "10", over_cap_amount_usdc: "1000", slippage_bps: 50 };
    const ideas = new MockModel().decide({ block: "51800000", gas_price_gwei: "1.005", eth_usd: 2695.0463635 }, cfg);
    const asked: string[] = [];
    const approve: Approver = async (tool) => {
      asked.push(tool);
      return tool === "swap_prepare" ? { approved: true, by: "test", reason: "unsigned" } : { approved: false, by: "test", reason: "no" };
    };
    const run = await runAgent(host, new ScriptedModel(scriptedNext(ideas, (i) => swap(rt, i.amount))), "go", approve);
    assert.deepEqual(run.calls.map((c) => c.tool), ["swap_quote", "swap_prepare", "swap_quote", "swap_prepare", "execute"]);
    assert.deepEqual(asked, ["swap_prepare", "swap_prepare", "execute"]);

    const quote = run.calls[0].envelope as { ok: true; result: { quotes: Array<{ venue: string; fee_disclosure: string }> } };
    assert.deepEqual(quote.result.quotes.map((q) => q.venue), ["sato", "lifi"]);
    assert.ok(quote.result.quotes.every((q) => q.fee_disclosure.length > 0));

    assert.equal(run.calls[1].envelope?.ok, true);
    const over = run.calls[3].envelope;
    assert.ok(over && !over.ok);
    if (over && !over.ok) {
      assert.equal(over.error.code, "policy_refused");
      const r = (over.error.refusals ?? []) as Array<{ rule: string; limit: string; observed: string }>;
      assert.ok(r.some((x) => x.rule === "max_usd_per_trade" && x.limit === String(loadPolicy(RECORDINGS_POLICY).max_usd_per_trade) && x.observed === "1000"));
    }
    assert.equal(run.calls[4].approval.gate, "interrupted");
    assert.equal(run.calls[4].approval.approved, false);
    assert.equal(run.calls[4].envelope, null);
    assert.equal(host.prepared.length, 2);
    assert.match(run.final_output, /no model API was called/);
  } finally {
    restore();
  }
});

test("a rejected prepare never reaches the kit", async () => {
  const rt = await fixtureRuntime();
  const host = buildHost(rt);
  const ideas = new MockModel().decide({ block: "1", gas_price_gwei: "1", eth_usd: 2695.0463635 }, { venue: "sato", amount_usdc: "10", over_cap_amount_usdc: "1000", slippage_bps: 50 });
  const run = await runAgent(host, new ScriptedModel(scriptedNext(ideas, (i) => swap(rt, i.amount))), "go", async () => ({ approved: false, by: "test", reason: "no" }));
  assert.equal(host.prepared.length, 0);
  assert.ok(run.calls.filter((c) => c.tool === "swap_prepare").every((c) => c.envelope === null && !c.approval.approved));
  assert.ok(!run.calls.some((c) => c.tool === "execute"));
});

test("live mode uses the SDK's default model unless --model-id names one", () => {
  assert.equal(DEFAULT_MODEL_ID, null);
  assert.equal(liveModel(null), undefined);
  assert.equal(liveModel("x"), "x");
});

test("live mode refuses to start without OPENAI_API_KEY, before any run", async () => {
  const host = buildHost(await fixtureRuntime());
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await assert.rejects(runLive(host, null, "x"), /OPENAI_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  }
});
