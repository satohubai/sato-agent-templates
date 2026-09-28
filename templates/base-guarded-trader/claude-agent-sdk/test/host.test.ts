// The Claude Agent SDK wiring: the kit's in-process server, the approval hook,
// the scripted driver fixture mode uses, and the options a live query() gets.
// Nothing here starts a model or the Claude Code binary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "viem";
import { buildRuntime, type Runtime } from "../src/runtime.js";
import { loadPolicy } from "../src/policy.js";
import { buildHost, callTool, connect, hookDecision, HOOK_MATCHER, runScripted, SERVER_NAME, type Approver } from "../src/host.js";
import { liveOptions, runLive } from "../src/live.js";
import { DEFAULT_MODEL_ID } from "../src/config.js";
import { MockModel, scriptedNext } from "../src/model.js";
import { TOKENS } from "../src/tokens.js";

async function fixtureRuntime(): Promise<Runtime> {
  const rt = await buildRuntime({ mode: "fixture", policy: loadPolicy("policy.json"), fixturesDir: "fixtures", env: {} });
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

test("the server is the kit's in-process SDK server and lists the kit's tools", async () => {
  const host = await buildHost(await fixtureRuntime());
  assert.equal(host.server.type, "sdk");
  assert.equal(host.server.name, SERVER_NAME);
  assert.equal(SERVER_NAME, "sato-kit");
  const client = await connect(host.server);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["chain_read", "swap_quote", "swap_prepare", "execute"]) assert.ok(names.includes(n), n);
  } finally {
    await client.close();
  }
});

test("the hook asks before swap_prepare and execute, and not before reads or quotes", async () => {
  const host = await buildHost(await fixtureRuntime());
  for (const t of ["swap_prepare", "execute"]) assert.equal((await hookDecision(host.hook, t, {})).decision, "ask", t);
  for (const t of ["swap_quote", "chain_read", "actions_search"]) assert.equal((await hookDecision(host.hook, t, {})).decision, "none", t);
  assert.equal(HOOK_MATCHER, "^mcp__sato-kit__");
});

test("execute through the server refuses any key besides intent_id", async () => {
  const host = await buildHost(await fixtureRuntime());
  const client = await connect(host.server);
  try {
    const env = await callTool(client, "execute", { intent_id: "si_" + "A".repeat(43), to: "0xattacker" }).catch((e: Error) => ({ ok: false, error: { message: e.message } }));
    assert.equal(env.ok, false);
  } finally {
    await client.close();
  }
});

test("the scripted turns quote, prepare, refuse the over-cap intent by name, and never run execute", async () => {
  const rt = await fixtureRuntime();
  const host = await buildHost(rt);
  const cfg = { venue: "sato" as const, amount_usdc: "10", over_cap_amount_usdc: "1000", slippage_bps: 50 };
  const ideas = new MockModel().decide({ block: "51800000", gas_price_gwei: "1.005", eth_usd: 2695.0463635 }, cfg);
  const asked: string[] = [];
  const approve: Approver = async (tool) => {
    asked.push(tool);
    return tool === "swap_prepare" ? { approved: true, by: "test", reason: "unsigned" } : { approved: false, by: "test", reason: "no" };
  };
  const done = await runScripted(host, scriptedNext(ideas, (i) => swap(rt, i.amount)), approve);
  assert.deepEqual(done.map((d) => d.turn.tool), ["swap_quote", "swap_prepare", "swap_quote", "swap_prepare", "execute"]);
  assert.deepEqual(asked, ["swap_prepare", "swap_prepare", "execute"]);

  const quote = done[0].envelope as { ok: true; result: { quotes: Array<{ venue: string; fee_disclosure: string }> } };
  assert.deepEqual(quote.result.quotes.map((q) => q.venue), ["sato", "lifi"]);
  assert.ok(quote.result.quotes.every((q) => q.fee_disclosure.length > 0));

  assert.equal(done[1].envelope?.ok, true);
  const over = done[3].envelope;
  assert.ok(over && !over.ok);
  if (over && !over.ok) {
    assert.equal(over.error.code, "policy_refused");
    const r = (over.error.refusals ?? []) as Array<{ rule: string; limit: string; observed: string }>;
    assert.ok(r.some((x) => x.rule === "max_usd_per_trade" && x.limit === "25" && x.observed === "1000"));
  }
  assert.equal(done[4].approval.approved, false);
  assert.equal(done[4].envelope, null);
  assert.equal(host.prepared.length, 2);
});

test("a live query() gets only the kit server, read tools pre-allowed, and the hook on PreToolUse", async () => {
  const host = await buildHost(await fixtureRuntime());
  const deny = async () => ({ behavior: "deny" as const, message: "test" });
  const o = liveOptions(host, DEFAULT_MODEL_ID, deny);
  assert.equal(o.model, "claude-opus-5-5");
  assert.deepEqual(o.tools, []);
  assert.deepEqual(Object.keys(o.mcpServers), ["sato-kit"]);
  assert.equal(o.mcpServers["sato-kit"], host.server);
  assert.ok(o.allowedTools.every((t) => t.startsWith("mcp__sato-kit__")));
  for (const t of ["swap_prepare", "x402_prepare", "execute"]) assert.ok(!o.allowedTools.includes(`mcp__sato-kit__${t}`), t);
  assert.equal(o.hooks.PreToolUse[0].matcher, HOOK_MATCHER);
  assert.equal(o.hooks.PreToolUse[0].hooks[0], host.hook);
});

test("live mode refuses to start without ANTHROPIC_API_KEY, before any query", async () => {
  const host = await buildHost(await fixtureRuntime());
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(runLive(host, DEFAULT_MODEL_ID, "x"), /ANTHROPIC_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});
