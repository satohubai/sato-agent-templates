// One pass of a guarded Base trading agent:
//   read the market -> the Model proposes ideas -> for each idea the kit
//   quotes (Sato Swap labelled, a no-Sato-fee quote alongside), prepares an
//   unsigned intent, simulates it and runs the policy pre-flight -> report.
//
// Fixture and fork runs NEVER call execute. Testnet runs execute only with
// --execute, through a managed wallet. Mainnet is not offered.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseUnits } from "viem";
import { parseArgs, parseConfig, UsageError, type AgentConfig } from "./config.js";
import { writeRpcFixtures } from "./fixtures.js";
import { ACTIONS, readQuotes, type SwapInput } from "./kit-io.js";
import { readMarket } from "./market.js";
import { MockModel, type Model, type TradeIdea } from "./model.js";
import { loadPolicy } from "./policy.js";
import { intentReport, line, printPrepared, refusalLine, type IntentReport } from "./report.js";
import { buildRuntime, USER_AGENT, type Runtime } from "./runtime.js";
import { TOKENS } from "./tokens.js";

const FIXTURES_DIR = "fixtures";

function swapInput(rt: Runtime, cfg: AgentConfig, idea: TradeIdea): SwapInput {
  const tin = TOKENS[rt.chain][idea.token_in];
  const tout = TOKENS[rt.chain][idea.token_out];
  return {
    chain: rt.chain,
    token_in: tin.address,
    token_out: tout.address,
    amount_in_base_units: parseUnits(idea.amount, tin.decimals).toString(),
    slippage_bps: cfg.slippage_bps,
    venue: cfg.venue,
    ...(rt.taker ? { taker: rt.taker } : {}),
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = parseConfig(JSON.parse(readFileSync(args.config, "utf8")));
  const policy = loadPolicy(args.policy);
  const model: Model = new MockModel();

  console.log(`base-guarded-trader — mode ${args.mode}`);
  console.log("The kit's pre-flight explains every refusal; enforcement lives in the signer.\n");
  console.log("Policy (policy.json, sato.policy/v1)");
  line("chains", policy.allow_chains.join(", "));
  line("tokens", policy.allow_tokens.join(", "));
  line("max per trade", `${policy.max_usd_per_trade} USD`);
  line("max per day", `${policy.max_usd_per_day} USD`);
  line("max slippage", `${policy.max_slippage_bps} bps`);
  line("unknown verdict", policy.unknown_verdict);
  line("intent ttl", `${policy.intent_ttl_s}s`);
  line("venue", cfg.venue === "sato" ? "sato (Sato Swap, labelled default; a no-Sato-fee quote is shown alongside)" : "direct (no Sato call)");

  const rt = await buildRuntime({ mode: args.mode, policy, fixturesDir: FIXTURES_DIR, env: process.env, record: args.record });
  line("signer", rt.signer ? `${rt.signer.kind} ${rt.taker}` : "none — fixture mode holds no key");
  line("user-agent", USER_AGENT);

  const market = await readMarket(rt);
  console.log(`\nMarket (read-only, ${market.chain})`);
  line("block", market.block);
  line("gas price", `${market.gas_price_gwei} gwei`);
  line("ETH/USD", market.eth_usd === null ? "unknown" : `${market.eth_usd.toFixed(2)} — ${market.eth_usd_feed}`);
  line("feed updated", market.eth_usd_updated_at ?? "unknown");

  const ideas = model.decide(market, cfg);
  console.log(`\nModel ${model.name}: ${ideas.length} idea(s)`);

  const reports: IntentReport[] = [];
  let demoRefused = false;
  let ownAllowed = false;
  for (const idea of ideas) {
    console.log(`\n— ${idea.label}`);
    line("why", idea.reason);
    const input = swapInput(rt, cfg, idea);

    const quote = await rt.kit.read(ACTIONS.swapQuote, input);
    for (const q of readQuotes(quote)) {
      line(`quote ${q.label ?? q.venue}`, `${q.amount_out_base_units} base units of ${idea.token_out}`);
      if (q.fee_disclosure) console.log(`  Fee disclosure (${q.fee_disclosure.venue}), verbatim:\n    ${q.fee_disclosure.statement}`);
    }

    const prepared = await rt.kit.prepare(ACTIONS.swapPrepare, input);
    printPrepared(prepared);
    reports.push(intentReport(idea.label, idea.demo_refusal, prepared));
    if (idea.demo_refusal && !prepared.policy.ok && prepared.policy.refusals.length > 0) demoRefused = true;
    if (!idea.demo_refusal && prepared.policy.ok) ownAllowed = true;

    if (args.execute && rt.mode === "testnet" && prepared.policy.ok && !idea.demo_refusal) {
      const receipt = await rt.kit.execute({ intent_id: prepared.intent_id });
      line("executed", `${receipt.status} ${receipt.tx_hash ?? ""}`);
    }
  }

  mkdirSync(args.out, { recursive: true });
  const report = {
    schema: "base-guarded-trader.report/v1",
    mode: args.mode,
    user_agent: USER_AGENT,
    model: model.name,
    venue: cfg.venue,
    market,
    intents: reports,
    executed: args.execute && rt.mode === "testnet",
  };
  writeFileSync(join(args.out, "report.json"), JSON.stringify(report, null, 2) + "\n");

  if (args.record && rt.recorded) {
    writeRpcFixtures(FIXTURES_DIR, rt.recorded, { recorded_from: "anvil fork of Base", note: "written by --mode fork --record" });
    console.log(`\nRecorded ${Object.keys(rt.recorded).length} RPC answer(s) into ${FIXTURES_DIR}/rpc.json`);
  }

  console.log(`\nReport written to ${join(args.out, "report.json")}`);
  if (!demoRefused) {
    console.log("\nFAIL: the over-cap demo intent was not refused. The pre-flight is not doing its job; stopping with an error.");
    return 1;
  }
  console.log(ownAllowed ? "\nDone. The agent's own intent passed the pre-flight; the over-cap intent was refused." : "\nDone. The agent's own intent did not pass the pre-flight (see the lines above); the over-cap intent was refused.");
  console.log(args.execute ? "" : "Nothing was signed, sent or spent.");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`\nStopped: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(e instanceof UsageError ? 2 : 1);
  },
);

