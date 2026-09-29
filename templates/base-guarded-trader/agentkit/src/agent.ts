// One pass of a guarded Base trading agent on Coinbase AgentKit:
//   AgentKit + the Sato Kit's action provider -> read the market (chain_read)
//   -> the Model proposes ideas and names the AgentKit actions to call ->
//   swap_quote (Sato Swap labelled, a no-Sato-fee quote alongside) ->
//   swap_prepare (unsigned intent, simulation, policy pre-flight) -> report.
//
// Fixture and fork runs NEVER call execute: the action provider is built
// without an approve callback, so it refuses execute itself. Testnet runs
// execute only with --execute, after a person types "yes" for that intent,
// through a CDP smart wallet. Mainnet is not offered.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { parseUnits } from "viem";
import { parseArgs, parseConfig, UsageError, type AgentConfig } from "./config.js";
import { writeHttpFixtures, writeRpcFixtures } from "./fixtures.js";
import { venueLabel, type ChainReadInput, type ChainReadOutput, type SwapInput, type SwapQuoteOutput } from "./kit-io.js";
import { buildAgentKit, preparedFrom, TOOLS, unwrap, type Envelope } from "./agentkit.js";
import type { PreparedIntent } from "@satohub/kit";
import { usdValue } from "./pricing.js";
import { readMarket } from "./market.js";
import { MockModel, type Model, type TradeIdea } from "./model.js";
import { loadPolicy } from "./policy.js";
import { intentReport, line, printPrepared, refusalLine, type IntentReport } from "./report.js";
import { buildRuntime, USER_AGENT, type Runtime } from "./runtime.js";
import { handOff, printHandOff, satoOsClock, satoOsRuntimeOptions, type HandOffItem, type HandOffResult } from "./sato-os.js";
import { TOKENS } from "./tokens.js";

const FIXTURES_DIR = "fixtures";

/** Asks the person at the terminal. Used only on testnet with --execute. */
async function askPerson(summary: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`\n  Approve? ${summary}\n  Type "yes" to approve: `);
    return answer.trim() === "yes";
  } finally {
    rl.close();
  }
}

function swapInput(rt: Runtime, cfg: AgentConfig, idea: TradeIdea): SwapInput {
  const tin = TOKENS[rt.chain][idea.token_in];
  const tout = TOKENS[rt.chain][idea.token_out];
  return {
    chain: rt.chain,
    sell_token: tin.address,
    buy_token: tout.address,
    sell_amount: parseUnits(idea.amount, tin.decimals).toString(),
    slippage_bps: cfg.slippage_bps,
    venue: cfg.venue,
    taker: rt.taker,
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = parseConfig(JSON.parse(readFileSync(args.config, "utf8")));
  const policy = loadPolicy(args.policy);
  const model: Model = new MockModel();

  console.log(`base-guarded-trader (AgentKit) — mode ${args.mode}`);
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

  const rt = await buildRuntime({ mode: args.mode, policy, fixturesDir: FIXTURES_DIR, env: process.env, record: args.record, ...(args.mode === "sato-os" ? { satoOs: await satoOsRuntimeOptions(args, process.env) } : {}) });
  line("signer", rt.signer ? `${rt.signer.kind} ${await rt.signer.address(rt.chain)}` : "none — fixture mode holds no key");
  line("wallet provider", `${rt.walletProvider.getName()} on ${rt.walletProvider.getNetwork().networkId}`);

  const canExecute = args.execute && rt.mode === "testnet";
  const ak = await buildAgentKit({
    kit: rt.kit,
    walletProvider: rt.walletProvider,
    policy: rt.policy,
    signerKind: rt.signer?.kind ?? null,
    ...(canExecute ? { approve: (summary: string) => askPerson(summary) } : {}),
  });
  line("AgentKit actions", ak.actions.map((a) => a.name).join(", "));
  line("execute", canExecute ? "asks you to type yes for each intent" : "refused by the action provider (no approve callback in this mode)");
  line("intents built for", rt.taker);
  line("user-agent", USER_AGENT);

  const market = await readMarket(rt, async <O>(input: ChainReadInput) => unwrap(await ak.call<ChainReadOutput<O>>(TOOLS.chainRead, input)));
  console.log(`\nMarket (read-only, ${market.chain})`);
  line("block", market.block);
  line("gas price", `${market.gas_price_gwei} gwei`);
  line("ETH/USD", market.eth_usd === null ? "unknown" : `${market.eth_usd.toFixed(2)} — ${market.eth_usd_feed}`);
  line("feed updated", market.eth_usd_updated_at ?? "unknown");
  rt.usd.eth_usd = market.eth_usd;
  line("USD for the caps", "USDC counted at 1.00 USD; WETH at the ETH/USD answer above; a venue's own USD value is used when it returns one");

  const ideas = model.decide(market, cfg);
  console.log(`\nModel ${model.name}: ${ideas.length} idea(s)`);

  const reports: IntentReport[] = [];
  const handOffItems: HandOffItem[] = [];
  let demoRefused = false;
  let ownAllowed = false;
  for (const idea of ideas) {
    console.log(`\n— ${idea.label}`);
    line("why", idea.reason);
    const input = swapInput(rt, cfg, idea);

    let prepared: PreparedIntent | null = null;
    for (const call of model.toolCalls(idea, input)) {
      line("AgentKit action", call.name);
      if (call.name === TOOLS.execute) throw new Error("the model asked for execute; this template never lets the model execute");
      const env = await ak.call(call.name, call.args);
      if (call.name === TOOLS.swapQuote) {
        const quote = unwrap(env as Envelope<SwapQuoteOutput>);
        console.log(`  ${quote.note}`);
        for (const q of quote.quotes) {
          line(`quote ${q.venue}`, `${venueLabel(q.venue)}: ${q.buy_amount ?? "no quote"} base units of ${idea.token_out}${q.route_via ? ` via ${q.route_via}` : ""}${q.error ? ` — ${q.error}` : ""}`);
          console.log(`    fee, verbatim: ${q.fee_disclosure}`);
        }
      } else if (call.name === TOOLS.swapPrepare) {
        prepared = preparedFrom(env as Envelope<PreparedIntent>);
        printPrepared(prepared);
      }
    }
    if (!prepared) throw new Error(`the model made no ${TOOLS.swapPrepare} call for "${idea.label}"`);
    reports.push(intentReport(idea.label, idea.demo_refusal, prepared));
    handOffItems.push({ label: reports[reports.length - 1].label, intent: prepared });
    if (idea.demo_refusal && !prepared.policy.ok && prepared.policy.refusals.length > 0) demoRefused = true;
    if (!idea.demo_refusal && prepared.policy.ok) ownAllowed = true;

    if (canExecute && prepared.policy.ok && !idea.demo_refusal) {
      const env = await ak.call<{ status: string; tx_hash?: string | null }>(TOOLS.execute, { intent_id: prepared.intent_id });
      if (!env.ok) {
        line("not executed", `${env.error.code}: ${env.error.message}`);
        continue;
      }
      const receipt = env.result;
      line("executed", `${receipt.status} ${receipt.tx_hash ?? ""}`);
      const spent = usdValue(rt.chain, input.sell_token, input.sell_amount, rt.usd);
      if (receipt.status === "executed" && spent !== null) rt.ledger.add(spent);
    }
  }

  // --mode sato-os: allowed intents go to Sato OS as proposals; refused ones are never sent.
  let satoOs: HandOffResult[] | null = null;
  if (rt.mode === "sato-os") {
    console.log("\nSato OS hand-off (a person approves in Sato OS; Sato OS signs, this agent does not)");
    satoOs = await handOff(handOffItems, { dir: args.sato_dir, clock: satoOsClock(args.data) });
    printHandOff(satoOs, line);
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
    ...(satoOs ? { sato_os: satoOs } : {}),
    executed: canExecute,
  };
  writeFileSync(join(args.out, "report.json"), JSON.stringify(report, null, 2) + "\n");

  if (args.record && rt.recorded) {
    writeRpcFixtures(FIXTURES_DIR, rt.recorded, { recorded_from: "anvil fork of Base", note: "written by --mode fork --record" });
    console.log(`\nRecorded ${Object.keys(rt.recorded).length} RPC answer(s) into ${FIXTURES_DIR}/rpc.json`);
    const names = writeHttpFixtures(FIXTURES_DIR, rt.recordedHttp ?? []);
    console.log(`Recorded ${names.length} venue response(s) into ${FIXTURES_DIR}/http/: ${names.join(", ")}`);
  }

  console.log(`\nReport written to ${join(args.out, "report.json")}`);
  if (!demoRefused) {
    console.log("\nFAIL: the over-cap demo intent was not refused. The pre-flight is not doing its job; stopping with an error.");
    return 1;
  }
  console.log(ownAllowed ? "\nDone. The agent's own intent passed the pre-flight; the over-cap intent was refused." : "\nDone. The agent's own intent did not pass the pre-flight (see the lines above); the over-cap intent was refused.");
  console.log(satoOs ? "Nothing was signed or sent from here; allowed intents wait in Sato OS for a person's approval." : args.execute ? "" : "Nothing was signed, sent or spent.");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`\nStopped: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(e instanceof UsageError ? 2 : 1);
  },
);

