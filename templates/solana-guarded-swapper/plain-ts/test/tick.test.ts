// The prepare + simulate path, run through the kit with a mocked Solana RPC and
// the recorded venue responses. Nothing here touches the network, and no test
// has a signer to call: the template has none.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SolanaRpc } from "@satohub/kit";
import { loadScenario, runTick, usdOfPrepared } from "../src/agent.js";
import { parseArgs, parseConfig, type AgentConfig } from "../src/config.js";
import { fixtureFetch, fixtureSolanaRpc, loadHttpFixtures, loadRpcFixtures } from "../src/fixtures.js";
import { loadPolicy } from "../src/policy.js";
import { buildRuntime, FIXTURE_CLOCK_MS, FIXTURE_WALLET } from "../src/runtime.js";

const cfg = (over: Record<string, unknown> = {}): AgentConfig => parseConfig({ ...JSON.parse(readFileSync("config.json", "utf8")), ...over });
const recorded = () => fixtureSolanaRpc(loadRpcFixtures("fixtures"));

/** An RPC that logs every call and can override one method. */
function spyRpc(over: Partial<Record<string, (params: readonly unknown[]) => unknown>> = {}): { rpc: SolanaRpc; calls: { method: string; params: readonly unknown[] }[] } {
  const calls: { method: string; params: readonly unknown[] }[] = [];
  const inner = recorded();
  return {
    calls,
    rpc: {
      async request(method, params) {
        calls.push({ method, params });
        const o = over[method];
        if (o) return o(params);
        return inner.request(method, params);
      },
    },
  };
}

async function fixtureRun(rpc: SolanaRpc, config = cfg(), out = mkdtempSync(join(tmpdir(), "sgs-tick-"))) {
  const args = parseArgs(["--out", out]);
  const rt = await buildRuntime({ mode: "fixture", policy: loadPolicy("policy.json", "fixture"), fixturesDir: "fixtures", stateDir: join(out, "state"), env: {}, wallet: null, inject: { rpc } });
  const tick = await runTick(rt, config, args, loadScenario());
  return { tick, out, rt };
}

test("a swap is simulated through simulateTransaction before anything is handed over, and the RPC is only ever read from", async () => {
  const { rpc, calls } = spyRpc();
  const { tick, out } = await fixtureRun(rpc);
  const methods = new Set(calls.map((c) => c.method));
  assert.deepEqual([...methods].sort(), ["getBalance", "simulateTransaction"], "no send, no signature, no write");
  const sims = calls.filter((c) => c.method === "simulateTransaction");
  assert.equal(sims.length, 3, "one simulation per prepared intent, including the refused ones");
  for (const s of sims) {
    const opts = s.params[1] as { sigVerify: boolean; encoding: string };
    assert.equal(opts.sigVerify, false, "simulated unsigned");
    assert.equal(opts.encoding, "base64");
  }
  assert.equal(tick.failure, null);
  const own = tick.intents[0];
  assert.equal(own.demo_refusal, false);
  assert.equal(own.policy_ok, true);
  assert.equal(own.simulation?.ok, true);
  assert.equal(own.simulation?.method, "simulateTransaction");
  assert.equal(own.unsigned.kind, "solana_tx");
  assert.deepEqual(tick.handoff, ["unsigned-1.json"]);
  const file = JSON.parse(readFileSync(join(out, "unsigned-1.json"), "utf8"));
  assert.equal(file.signed, false);
  assert.equal(file.simulation.ok, true);
  assert.equal(file.fee_payer, FIXTURE_WALLET);
  assert.match(file.note, /holds no key/);
});

test("the same swap twice in one day: the second is refused by max_usd_per_day with its limit and observed value", async () => {
  const { tick } = await fixtureRun(spyRpc().rpc);
  const again = tick.intents[1];
  assert.equal(again.policy_ok, false);
  const r = again.refusals.find((x) => x.rule === "max_usd_per_day")!;
  assert.ok(r, "max_usd_per_day refused it");
  assert.equal(r.limit, "20");
  assert.ok(Number(r.observed) > 20 && Number(r.observed) < 25, `observed ${r.observed}`);
  assert.equal(again.handoff_file, null, "a refused swap is never written out to sign");
});

test("an oversized swap is refused by the per-swap caps", async () => {
  const { tick } = await fixtureRun(spyRpc().rpc);
  const big = tick.intents[2];
  assert.equal(big.policy_ok, false);
  const rules = big.refusals.map((x) => x.rule);
  assert.ok(rules.includes("max_usd_per_trade") && rules.includes("max_per_trade"), rules.join(","));
  for (const r of big.refusals) assert.ok(r.rule && r.limit && r.observed);
});

test("a failed simulation refuses the intent and writes nothing to sign", async () => {
  const { rpc } = spyRpc({ simulateTransaction: () => ({ context: { slot: 1 }, value: { err: { InstructionError: [2, "Custom"] }, logs: ["Program log: failed: slippage"], unitsConsumed: 1 } }) });
  const { tick, out } = await fixtureRun(rpc);
  const own = tick.intents[0];
  assert.equal(own.policy_ok, false);
  assert.ok(own.refusals.some((r) => r.rule === "simulation_failed"));
  assert.equal(own.simulation?.ok, false);
  assert.deepEqual(tick.handoff, []);
  assert.deepEqual(readdirSync(out).filter((f) => f.startsWith("unsigned-")), []);
  assert.equal(tick.failure, null, "every cap check was still refused; nothing about the run itself failed");
});

test("an RPC that cannot simulate refuses the intent: simulation is required, not optional", async () => {
  const { rpc } = spyRpc({
    simulateTransaction: () => {
      throw new Error("method not supported by this RPC");
    },
  });
  const { tick } = await fixtureRun(rpc);
  const own = tick.intents[0];
  assert.equal(own.policy_ok, false);
  assert.ok(own.refusals.some((r) => r.rule === "simulation_required"), own.refusals.map((r) => r.rule).join(","));
  assert.deepEqual(tick.handoff, []);
});

test("no price drop: nothing is prepared and nothing is written", async () => {
  const { tick, out } = await fixtureRun(spyRpc().rpc, cfg({ reference_price_usd: 100 }));
  assert.equal(tick.watch.fired, false);
  assert.match(tick.watch.why, /the threshold is 5%/);
  assert.equal(tick.intents.filter((i) => !i.demo_refusal).length, 0);
  assert.deepEqual(tick.handoff, []);
});

test("a wallet that would be left under keep_sol is skipped with the numbers", async () => {
  const { rpc } = spyRpc({ getBalance: () => ({ context: { slot: 1 }, value: 120_000_000 }) });
  // The recorded getBalance key is for the fixed wallet; override the method to a small balance.
  const { tick } = await fixtureRun(rpc);
  assert.equal(tick.watch.fired, true);
  assert.match(tick.watch.skipped ?? "", /would leave less than keep_sol \(0\.05 SOL\)/);
  assert.equal(tick.intents.filter((i) => !i.demo_refusal).length, 0);
});

test("the day's total survives a restart, resets on a new UTC day, and a swap that cleared the pre-flight uses up the day's room", async () => {
  const state = mkdtempSync(join(tmpdir(), "sgs-state-"));
  const out = mkdtempSync(join(tmpdir(), "sgs-out-"));
  const config = cfg({ reference_price_usd: 120 });
  const args = parseArgs(["--mode", "live", "--accept-mainnet-risk", "--out", out, "--state-dir", state]);
  const policy = loadPolicy("policy.json", "fixture"); // the file says fork; the live-mode gate is tested in policy.test.ts
  const make = (clock: number) =>
    buildRuntime({
      mode: "live",
      policy,
      fixturesDir: "fixtures",
      stateDir: state,
      env: {},
      wallet: FIXTURE_WALLET,
      inject: { rpc: recorded(), fetch: fixtureFetch(loadHttpFixtures("fixtures")), clock: () => clock },
    });

  const first = await runTick(await make(FIXTURE_CLOCK_MS), config, args, null);
  assert.equal(first.intents.length, 1);
  assert.equal(first.intents[0].policy_ok, true);
  const ledger = JSON.parse(readFileSync(join(state, "ledger.json"), "utf8"));
  assert.equal(ledger.day, "2026-10-09");
  assert.ok(ledger.usd_prepared > 10 && ledger.usd_prepared < 12);

  // A new process, an hour later, the same UTC day: the cap remembers.
  const second = await runTick(await make(FIXTURE_CLOCK_MS + 3_600_000), config, args, null);
  assert.equal(second.intents[0].policy_ok, false);
  assert.equal(second.intents[0].refusals[0].rule, "max_usd_per_day");
  assert.deepEqual(second.handoff, [], "the refused swap's file is not left behind");
  assert.ok(!existsSync(join(out, "unsigned-1.json")), "stale unsigned files from an earlier run are cleared");

  // The next UTC day starts at zero.
  const third = await runTick(await make(Date.parse("2026-10-10T00:30:00Z")), config, args, null);
  assert.equal(third.intents[0].policy_ok, true);
});

test("live mode keeps the highest price seen, and re-arms from the swap's price after one is prepared", async () => {
  const state = mkdtempSync(join(tmpdir(), "sgs-state-"));
  const out = mkdtempSync(join(tmpdir(), "sgs-out-"));
  const args = parseArgs(["--mode", "live", "--accept-mainnet-risk", "--out", out, "--state-dir", state]);
  const make = () => buildRuntime({ mode: "live", policy: loadPolicy("policy.json", "fixture"), fixturesDir: "fixtures", stateDir: state, env: {}, wallet: FIXTURE_WALLET, inject: { rpc: recorded(), fetch: fixtureFetch(loadHttpFixtures("fixtures")), clock: () => FIXTURE_CLOCK_MS } });
  const config = cfg({ reference_price_usd: null });

  // No reference yet: the first run records the price and prepares nothing.
  const first = await runTick(await make(), config, args, null);
  assert.equal(first.watch.fired, false);
  assert.match(first.watch.why, /no reference price yet/);
  const st1 = JSON.parse(readFileSync(join(state, "state.json"), "utf8"));
  assert.ok(st1.high_price_usd > 100 && st1.high_price_usd < 120);

  // Pretend the price was higher before: now it has fallen past the threshold.
  writeState(state, st1.high_price_usd * 1.2);
  const second = await runTick(await make(), config, args, null);
  assert.equal(second.watch.fired, true);
  assert.equal(second.watch.reference_source, "state");
  assert.equal(second.intents[0].policy_ok, true);
  const st2 = JSON.parse(readFileSync(join(state, "state.json"), "utf8"));
  assert.ok(Math.abs(st2.high_price_usd - st1.high_price_usd) < 0.01, "re-armed from the price it swapped at");
});

import { writeFileSync } from "node:fs";
function writeState(dir: string, high: number): void {
  writeFileSync(join(dir, "state.json"), JSON.stringify({ high_price_usd: high }));
}

test("the USD figure the daily total adds comes from the kit's summary, with a conservative fallback to the quotes", () => {
  const p = { summary: "Swap ... quoted 1. USD value: 10.5 (venue: jupiter returned swapUsdValue)." } as Parameters<typeof usdOfPrepared>[0];
  assert.equal(usdOfPrepared(p, []), 10.5);
  const reworded = { summary: "Swap ... worth about 10 dollars." } as Parameters<typeof usdOfPrepared>[0];
  const q = (swap_usd: number | null, out: string | null) => ({ swap_usd, out_amount: out, error: null }) as never;
  assert.equal(usdOfPrepared(reworded, [q(10.9, "10000000"), q(null, "10900000")]), 10.9, "the highest figure, so the day's total can only be over-counted");
  assert.equal(usdOfPrepared(reworded, []), null);
});
