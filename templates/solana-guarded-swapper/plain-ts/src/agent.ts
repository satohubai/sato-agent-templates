// One tick of a guarded Solana swapper:
//
//   read the wallet's SOL -> read the SOL price from a Jupiter quote -> has it
//   fallen past the threshold? -> if so, quote the swap (Sato Route labelled,
//   a no-Sato-fee Jupiter quote alongside), build the UNSIGNED Jupiter
//   transaction, simulate it, run the policy pre-flight -> write the report and
//   the unsigned transaction -> stop.
//
// There is no signer here, in any mode. Signing is your wallet's job, after you
// have read the transaction. The kit's `execute` is never called.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PreparedIntent } from "@satohub/kit";
import { parseArgs, parseConfig, UsageError, type AgentConfig, type Args } from "./config.js";
import { writeHttpFixtures, writeRpcFixtures } from "./fixtures.js";
import { ACTIONS, CHAIN, venueLabel, type SolBalanceInput, type SolBalanceOutput, type SwapInput, type SwapQuoteOutput } from "./kit-io.js";
import { loadPolicy } from "./policy.js";
import { isMain } from "./is-main.js";
import { intentReport, line, printPrepared, type IntentReport } from "./report.js";
import { buildRuntime, FIXTURE_WALLET, USER_AGENT, type Runtime } from "./runtime.js";
import { LAMPORTS_PER_SOL, lamportsToSol, solToLamports, USDC_MINT, usdcToUsd, WSOL_MINT } from "./tokens.js";
import { decide, impliedPriceUsd, loadState, saveState, type Decision } from "./watch.js";

const FIXTURES_DIR = "fixtures";

export type Scenario = { reference_price_usd: number; over_size_sol: string };

export function loadScenario(dir = FIXTURES_DIR): Scenario {
  const s = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) as Partial<Scenario>;
  if (typeof s.reference_price_usd !== "number" || !(s.reference_price_usd > 0) || typeof s.over_size_sol !== "string") throw new Error("fixtures/scenario.json: reference_price_usd (a positive number) and over_size_sol (a SOL amount) are required");
  return { reference_price_usd: s.reference_price_usd, over_size_sol: s.over_size_sol };
}

function swapInput(rt: Runtime, cfg: AgentConfig, lamports: bigint, venue: SwapInput["venue"]): SwapInput {
  return { chain: CHAIN, input_mint: WSOL_MINT, output_mint: USDC_MINT, amount: lamports.toString(), taker: rt.wallet, slippage_bps: cfg.slippage_bps, venue };
}

export type Tick = {
  watch: {
    wallet: string;
    balance_lamports: string | null;
    sell_lamports: string;
    keep_lamports: string;
    price_usd: number | null;
    price_source: string;
    reference_usd: number | null;
    reference_source: Decision["reference_source"];
    drop_pct: number | null;
    threshold_pct: number;
    fired: boolean;
    why: string;
    skipped: string | null;
  };
  intents: IntentReport[];
  /** Files written for you to sign, relative to --out. */
  handoff: string[];
  /** Why the run failed, or null. A failure is a pre-flight that did not do its job, not a refusal. */
  failure: string | null;
};

/** The cap checks that run in fixture mode, so the pre-flight's refusals are visible without waiting for a drop. */
const CAP_CHECKS = {
  again: "cap check: the same swap once the day's room is used up (the daily cap)",
  oversize: "cap check: an oversized swap (the per-swap cap)",
} as const;

export async function runTick(rt: Runtime, cfg: AgentConfig, args: Args, scenario: Scenario | null): Promise<Tick> {
  const sell = solToLamports(cfg.sell_sol);
  const keep = solToLamports(cfg.keep_sol);
  const stateful = rt.mode === "live" && !args.record;

  // 1. read the wallet
  const bal = await rt.kit.read<SolBalanceOutput>(ACTIONS.solanaRead, { chain: CHAIN, kind: "sol_balance", address: rt.wallet } satisfies SolBalanceInput);
  const balance = bal.amount === null ? null : BigInt(bal.amount);
  console.log(`\nWallet (read-only, ${CHAIN})`);
  line("address", rt.wallet);
  line("SOL balance", balance === null ? "account does not exist (0 SOL)" : `${lamportsToSol(balance)} SOL (${balance} lamports) at slot ${bal.slot ?? "n/a"}`);

  // 2. read the price: a Jupiter quote for the amount that would be sold
  const probe = await rt.kit.read<SwapQuoteOutput>(ACTIONS.swapQuote, swapInput(rt, cfg, sell, "direct"));
  const q = probe.quotes[0];
  const price = q && !q.error && q.out_amount ? impliedPriceUsd(sell, q.out_amount) : null;
  console.log("\nPrice (a Jupiter quote, not an oracle; USDC counted as 1 USD)");
  line("SOL/USD", price === null ? `unknown${q?.error ? ` — ${q.error}` : ""}` : `${price.toFixed(2)} for ${cfg.sell_sol} SOL${q?.route_via ? ` via ${q.route_via}` : ""}`);

  // 3. has it fallen far enough?
  let reference: { usd: number; source: "config" | "state" } | null = null;
  if (cfg.reference_price_usd !== null) reference = { usd: cfg.reference_price_usd, source: "config" };
  else if (rt.mode === "fixture" || args.record) reference = { usd: scenario!.reference_price_usd, source: "config" };
  else {
    const st = loadState(args.state_dir);
    if (st.high_price_usd !== null) reference = { usd: st.high_price_usd, source: "state" };
  }
  const decision = decide(price, reference, cfg.drop_pct);
  line("reference", decision.reference_usd === null ? "none yet" : `${decision.reference_usd} (${decision.reference_source === "config" ? "config.json or the fixture scenario" : "highest price seen, .sato/state.json"})`);
  line("drop", decision.drop_pct === null ? "n/a" : `${decision.drop_pct}% (threshold ${cfg.drop_pct}%)`);
  line("decision", decision.why);

  let skipped: string | null = null;
  const ownRuns = decision.fire;
  if (decision.fire && balance !== null && balance < sell + keep) skipped = `the wallet holds ${lamportsToSol(balance)} SOL; selling ${cfg.sell_sol} SOL would leave less than keep_sol (${cfg.keep_sol} SOL)`;
  if (decision.fire && balance === null) skipped = "the wallet account does not exist on this cluster";
  if (skipped) line("skipped", skipped);

  const watch: Tick["watch"] = {
    wallet: rt.wallet,
    balance_lamports: balance === null ? null : balance.toString(),
    sell_lamports: sell.toString(),
    keep_lamports: keep.toString(),
    price_usd: price,
    price_source: "jupiter quote (venue direct)",
    reference_usd: decision.reference_usd,
    reference_source: decision.reference_source,
    drop_pct: decision.drop_pct,
    threshold_pct: cfg.drop_pct,
    fired: decision.fire,
    why: decision.why,
    skipped,
  };

  // 4. the swaps to prepare
  type Idea = { label: string; reason: string; lamports: bigint; demo: boolean; kind: "own" | "again" | "oversize" };
  const ideas: Idea[] = [];
  if (ownRuns && !skipped) ideas.push({ label: `swap ${cfg.sell_sol} SOL to USDC`, reason: decision.why, lamports: sell, demo: false, kind: "own" });
  if (rt.mode === "fixture" || args.record) {
    ideas.push({ label: CAP_CHECKS.again, reason: "the same swap after earlier swaps have used up the day's room in policy.json; the daily cap must refuse it", lamports: sell, demo: true, kind: "again" });
    ideas.push({ label: CAP_CHECKS.oversize, reason: `${scenario!.over_size_sol} SOL, far over the per-swap cap; the pre-flight must refuse it`, lamports: solToLamports(scenario!.over_size_sol), demo: true, kind: "oversize" });
  }

  const reports: IntentReport[] = [];
  const handoff: string[] = [];
  let ownOk = false;
  let againRefused = false;
  let oversizeRefused = false;

  if (args.out && existsSync(args.out)) for (const f of readdirSync(args.out)) if (/^unsigned-\d+\.json$/.test(f)) rmSync(join(args.out, f));

  for (const idea of ideas) {
    console.log(`\n— ${idea.label}`);
    line("why", idea.reason);
    if (idea.kind === "again") {
      // The recordings hold one swap size, so the day's room is used up as if earlier swaps had done it: top the
      // in-memory total up to $1 under whatever daily cap policy.json carries. Fixture and --record runs only.
      const cap = rt.policy.max_usd_per_day ?? 0;
      const spent = rt.ledger.spentToday() ?? 0;
      const target = Math.max(0, cap - 1);
      if (spent < target) rt.ledger.add(target - spent);
      line("day so far", `${(rt.ledger.spentToday() ?? 0).toFixed(2)} USD (the first swap plus a stand-in for earlier ones) of the ${cap} USD daily cap`);
    }
    const input = swapInput(rt, cfg, idea.lamports, cfg.venue);

    const quote = await rt.kit.read<SwapQuoteOutput>(ACTIONS.swapQuote, input);
    console.log(`  ${quote.note}`);
    for (const qq of quote.quotes) {
      line(`quote ${qq.venue}`, `${venueLabel(qq.venue)}: ${qq.out_amount ? `${usdcToUsd(qq.out_amount).toFixed(6)} USDC` : "no quote"}${qq.route_via ? ` via ${qq.route_via}` : ""}${qq.error ? ` — ${qq.error}` : ""}`);
      console.log(`    fee, verbatim: ${qq.fee_disclosure}`);
    }

    let prepared: PreparedIntent;
    try {
      prepared = await rt.kit.prepare(ACTIONS.swapPrepare, input);
    } catch (e) {
      // A swap the kit would not build is output, not a crash: say why and move on.
      const why = e instanceof Error ? e.message : String(e);
      if (idea.demo) throw new Error(`the cap check "${idea.label}" could not be prepared: ${why}`);
      line("not prepared", why);
      continue;
    }
    printPrepared(prepared);
    if (idea.kind === "own" && rt.mode === "fixture" && !prepared.policy.ok && prepared.policy.refusals.some((r) => r.rule === "max_usd_per_trade" || r.rule === "max_usd_per_day")) {
      line("note", "fixture mode replays one recorded swap size (0.1 SOL). Your caps in policy.json are below its value, so it is refused. Try a smaller sell_sol with --mode live.");
    }

    let file: string | null = null;
    if (!idea.demo && prepared.policy.ok && prepared.unsigned.kind === "solana_tx") {
      mkdirSync(args.out, { recursive: true });
      const name = `unsigned-${handoff.length + 1}.json`;
      writeFileSync(join(args.out, name), JSON.stringify(unsignedFile(prepared), null, 2) + "\n");
      handoff.push(name);
      file = name;
    }
    reports.push(intentReport(idea.label, idea.demo, prepared, file));

    if (prepared.policy.ok) {
      // A swap that clears the pre-flight uses up the day's room, signed or not.
      const usd = usdOfPrepared(prepared, quote.quotes);
      if (usd !== null) rt.ledger.add(usd);
      else rt.ledger.markUnknown("the USD value of a prepared swap could not be read");
    }
    if (idea.kind === "own") ownOk = prepared.policy.ok;
    if (idea.kind === "again") againRefused = !prepared.policy.ok && prepared.policy.refusals.some((r) => r.rule === "max_usd_per_day");
    if (idea.kind === "oversize") oversizeRefused = !prepared.policy.ok && prepared.policy.refusals.length > 0;
  }

  // 5. state for the next live run: remember the high, and re-arm after a prepared swap
  if (stateful && price !== null) {
    const st = loadState(args.state_dir);
    const high = ownOk ? price : Math.max(st.high_price_usd ?? 0, price);
    if (cfg.reference_price_usd === null) saveState(args.state_dir, { high_price_usd: high });
  }

  let failure: string | null = null;
  if ((rt.mode === "fixture" || args.record) && !oversizeRefused) failure = `the oversized cap check (${scenario!.over_size_sol} SOL) was not refused. Either policy.json now allows a swap that large, or the pre-flight is not doing its job`;
  else if ((rt.mode === "fixture" || args.record) && !againRefused) failure = "the swap was not refused once the day's room was used up: the daily cap is not being counted";
  return { watch, intents: reports, handoff, failure };
}

/**
 * The USD value of a prepared swap, for the daily total. The kit states the
 * figure it used in the intent's summary ("USD value: 10.89 (source)"); if that
 * text ever changes, fall back to the highest USD figure among the quotes just
 * read (Jupiter's own swapUsdValue, else the USDC leg), which can only
 * over-count. null means the value could not be found at all.
 */
export function usdOfPrepared(p: PreparedIntent, quotes: SwapQuoteOutput["quotes"]): number | null {
  const m = /USD value: ([0-9]+(?:\.[0-9]+)?) \(/.exec(p.summary);
  if (m) return Number(m[1]);
  const figs = quotes.map((q) => q.swap_usd ?? (q.out_amount && !q.error ? usdcToUsd(q.out_amount) : null)).filter((x): x is number => x !== null && Number.isFinite(x));
  return figs.length > 0 ? Math.max(...figs) : null;
}

function unsignedFile(p: PreparedIntent): unknown {
  const u = p.unsigned;
  if (u.kind !== "solana_tx") throw new Error("expected a solana_tx");
  return {
    schema: "solana-guarded-swapper.unsigned/v1",
    signed: false,
    intent_id: p.intent_id,
    summary: p.summary,
    expires_at: p.expires_at,
    chain: u.chain,
    fee_payer: u.fee_payer,
    transaction_base64: u.transaction_base64,
    recent_blockhash: u.recent_blockhash,
    last_valid_block_height: u.last_valid_block_height,
    simulation: p.simulation,
    fee_disclosure: p.fee_disclosure,
    policy: p.policy,
    note: "Unsigned. Read it, simulate it again right before you sign, and sign it with your own wallet only if you mean to swap. This file holds no key.",
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = parseConfig(JSON.parse(readFileSync(args.config, "utf8")));
  const policy = loadPolicy(args.policy, args.mode);
  const scenario = args.mode === "fixture" || args.record ? loadScenario() : null;

  console.log(`solana-guarded-swapper — mode ${args.mode}`);
  console.log("The kit's pre-flight explains every refusal. This agent has no signer: it stops at an unsigned transaction.\n");
  console.log("Policy (policy.json, sato.policy/v1)");
  line("network", args.mode === "live" ? "mainnet (policy.json says mainnet; live mode needs it)" : `${policy.network} in policy.json; fixture mode replays recorded mainnet answers, nothing live`);
  line("chains", policy.allow_chains.join(", "));
  line("tokens", policy.allow_tokens.join(", "));
  line("max per swap", `${policy.max_usd_per_trade} USD`);
  line("max per day", `${policy.max_usd_per_day} USD (counts swaps this agent prepared today, signed or not)`);
  line("max slippage", `${policy.max_slippage_bps} bps`);
  line("unknown verdict", policy.unknown_verdict);
  line("intent ttl", `${policy.intent_ttl_s}s`);
  line("venue", cfg.venue === "sato" ? "sato (Sato Route, labelled default; a no-Sato-fee Jupiter quote is shown alongside)" : "direct (Jupiter only; no Sato call)");
  line("sell / keep", `${cfg.sell_sol} SOL per swap / ${cfg.keep_sol} SOL stays in the wallet`);
  line("trigger", `SOL ${cfg.drop_pct}% or more below the reference price`);

  const rt = await buildRuntime({ mode: args.mode, policy, fixturesDir: FIXTURES_DIR, stateDir: args.state_dir, env: process.env, wallet: cfg.wallet, record: args.record });
  line("signer", "none — this template holds no key");
  line("intents built for", rt.wallet === FIXTURE_WALLET && args.mode === "fixture" ? `${rt.wallet} (a fixed public address used by the recordings)` : rt.wallet);
  line("solana rpc", rt.rpcHost ?? "none — fixture mode uses the recordings");
  line("user-agent", USER_AGENT);
  if (args.mode === "fixture") console.log("\nTip: run `npm run preflight` to check the installed packages against their Sato Check receipts on Solana.");

  const tick = await runTick(rt, cfg, args, scenario);

  mkdirSync(args.out, { recursive: true });
  const report = {
    schema: "solana-guarded-swapper.report/v1",
    mode: args.mode,
    user_agent: USER_AGENT,
    venue: cfg.venue,
    network: "mainnet",
    watch: tick.watch,
    intents: tick.intents,
    handoff: tick.handoff,
    signed: false,
    broadcast: false,
  };
  writeFileSync(join(args.out, "report.json"), JSON.stringify(report, null, 2) + "\n");

  if (args.record) {
    writeRpcFixtures(FIXTURES_DIR, rt.recorded ?? {}, { recorded_from: "Solana mainnet-beta, public RPC", recorded_at: new Date().toISOString(), note: "written by --mode live --record --accept-mainnet-risk" });
    console.log(`\nRecorded ${Object.keys(rt.recorded ?? {}).length} Solana RPC answer(s) into ${FIXTURES_DIR}/rpc.json`);
    const names = writeHttpFixtures(FIXTURES_DIR, rt.recordedHttp ?? []);
    console.log(`Recorded ${names.length} venue response(s) into ${FIXTURES_DIR}/http/: ${names.join(", ")}`);
  }

  console.log(`\nReport written to ${join(args.out, "report.json")}`);
  if (tick.failure) {
    console.log(`\nFAIL: ${tick.failure}. Stopping with an error.`);
    return 1;
  }
  if (tick.handoff.length > 0) {
    console.log(`\nDone. ${tick.handoff.length} unsigned transaction${tick.handoff.length === 1 ? "" : "s"} written: ${tick.handoff.map((h) => join(args.out, h)).join(", ")}.`);
    console.log("Nothing was signed, sent or spent. Read the transaction, simulate it again right before you sign, and sign it with your own wallet only if you mean to swap.");
  } else {
    console.log("\nDone. No swap was prepared this tick. Nothing was signed, sent or spent.");
  }
  return 0;
}

// Only run when started as a script, so tests can import runTick.
if (isMain(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`\nStopped: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(e instanceof UsageError ? 2 : 1);
    },
  );
}
