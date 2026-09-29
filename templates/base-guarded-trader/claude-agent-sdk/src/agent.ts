// One pass of a guarded Base trading agent:
//   read the market -> the Model proposes ideas -> a Claude Agent SDK host
//   (the kit's in-process MCP server + an approval hook) quotes (Sato Swap
//   labelled, a no-Sato-fee quote alongside), prepares an unsigned intent,
//   simulates it and runs the policy pre-flight -> report.
//
// --model scripted (default) drives that server with a fixed turn list and
// starts no model. --model claude runs a real query().
//
// Fixture and fork runs NEVER execute: the hook asks, and nobody approves.
// Testnet runs execute only with --execute and a person's yes, through a
// managed wallet. Mainnet is not offered.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseUnits } from "viem";
import type { PreparedIntent } from "@satohub/kit";
import { parseArgs, parseConfig, UsageError, type AgentConfig } from "./config.js";
import { writeHttpFixtures, writeRpcFixtures } from "./fixtures.js";
import { venueLabel, type SwapInput, type SwapQuoteOutput } from "./kit-io.js";
import { buildHost, connect, HOOK_MATCHER, runScripted, SERVER_NAME, type Approval, type Approver, type Envelope, type Host } from "./host.js";
import { livePrompt, runLive } from "./live.js";
import { usdValue } from "./pricing.js";
import { readMarket } from "./market.js";
import { MockModel, SCRIPTED_MODEL_NAME, scriptedNext, type Model, type TradeIdea } from "./model.js";
import { loadPolicy } from "./policy.js";
import { intentReport, line, printPrepared, type IntentReport } from "./report.js";
import { buildRuntime, USER_AGENT, type Runtime } from "./runtime.js";
import { handOff, printHandOff, satoOsClock, satoOsRuntimeOptions, type HandOffItem, type HandOffResult } from "./sato-os.js";
import { TOKENS } from "./tokens.js";

const FIXTURES_DIR = "fixtures";

/** The tool names the server lists over MCP: what a model would see. */
async function listedTools(host: Host): Promise<string[]> {
  const client = await connect(host.server);
  try {
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

/**
 * Scripted runs answer the hook's "ask" without prompting anyone:
 * swap_prepare is approved (it builds an unsigned intent and signs nothing);
 * execute is declined unless this is a testnet run with --execute, where the
 * person at the terminal is asked.
 */
function scriptedApprover(allowExecute: boolean): Approver {
  return async (tool, args) => {
    if (tool === "swap_prepare") return { approved: true, by: "the fixture script", reason: "prepare builds an unsigned intent; nothing is signed" };
    if (tool === "execute" && allowExecute) {
      const { terminalApproval } = await import("./live.js");
      const r = await terminalApproval()(`mcp__${SERVER_NAME}__execute`, args, { signal: new AbortController().signal } as never);
      if (r && r.behavior === "allow") return { approved: true, by: "the person at the terminal", reason: "approved" };
      return { approved: false, by: "the person at the terminal", reason: r && r.behavior === "deny" ? r.message : "declined" };
    }
    return { approved: false, by: "the fixture script", reason: "no person approves execute in this mode, so it never runs" };
  };
}

function printEnvelope(tool: string, env: Envelope | null): void {
  if (!env) return line("result", "not called");
  if (tool === "swap_quote" && env.ok) {
    const quote = env.result as SwapQuoteOutput;
    console.log(`  ${quote.note}`);
    for (const q of quote.quotes) {
      line(`quote ${q.venue}`, `${venueLabel(q.venue)}: ${q.buy_amount ?? "no quote"} base units${q.route_via ? ` via ${q.route_via}` : ""}${q.error ? ` — ${q.error}` : ""}`);
      console.log(`    fee, verbatim: ${q.fee_disclosure}`);
    }
    return;
  }
  if (tool === "swap_prepare") {
    const intent = env.ok ? (env.result as PreparedIntent) : env.intent;
    if (intent) return printPrepared(intent);
  }
  if (tool === "execute" && env.ok) return line("executed", JSON.stringify(env.result));
  if (!env.ok) line("error", `${env.error.code}: ${env.error.message}`);
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

  const rt = await buildRuntime({ mode: args.mode, policy, fixturesDir: FIXTURES_DIR, env: process.env, record: args.record, ...(args.mode === "sato-os" ? { satoOs: await satoOsRuntimeOptions(args, process.env) } : {}) });
  line("signer", rt.signer ? `${rt.signer.kind} ${await rt.signer.address(rt.chain)}` : "none — fixture mode holds no key");
  line("intents built for", rt.taker);
  line("user-agent", USER_AGENT);

  const market = await readMarket(rt);
  console.log(`\nMarket (read-only, ${market.chain})`);
  line("block", market.block);
  line("gas price", `${market.gas_price_gwei} gwei`);
  line("ETH/USD", market.eth_usd === null ? "unknown" : `${market.eth_usd.toFixed(2)} — ${market.eth_usd_feed}`);
  line("feed updated", market.eth_usd_updated_at ?? "unknown");
  rt.usd.eth_usd = market.eth_usd;
  line("USD for the caps", "USDC counted at 1.00 USD; WETH at the ETH/USD answer above; a venue's own USD value is used when it returns one");

  const ideas = model.decide(market, cfg);
  console.log(`\nModel ${model.name}: ${ideas.length} idea(s)`);
  for (const idea of ideas) line(idea.demo_refusal ? "demo idea" : "idea", `${idea.label} — ${idea.reason}`);

  // The Claude Agent SDK host: the kit's in-process MCP server + the approval hook.
  const host = await buildHost(rt);
  const toolNames = await listedTools(host);
  console.log(`\nClaude Agent SDK host`);
  line("server", `${SERVER_NAME} (createSatoKitSdkServer, in-process)`);
  line("tools", toolNames.join(", "));
  line("approval hook", `requireApprovalHook on PreToolUse, matcher ${HOOK_MATCHER}`);
  const approvals: Approval[] = [];
  let modelName: string;

  if (args.model === "claude") {
    modelName = args.model_id;
    line("model", `${args.model_id} via query(); swap_prepare and execute ask you first`);
    const own = ideas.find((i) => !i.demo_refusal);
    const over = ideas.find((i) => i.demo_refusal);
    if (!own || !over) throw new Error("the market read gave no price, so there is nothing to ask the model about");
    await runLive(host, args.model_id, livePrompt(market, cfg, { own: swapInput(rt, cfg, own), overCap: swapInput(rt, cfg, over) }));
  } else {
    modelName = SCRIPTED_MODEL_NAME;
    line("model", `${SCRIPTED_MODEL_NAME} — a fixed turn list; no model and no Claude Code process is started`);
    const approve = scriptedApprover(args.execute && rt.mode === "testnet");
    await runScripted(host, scriptedNext(ideas, (idea) => swapInput(rt, cfg, idea)), approve, (r) => {
      console.log(`\n— turn ${r.turn.tool}: ${r.turn.note}`);
      if (r.approval.hook === "ask") line("hook", `ask → ${r.approval.approved ? "approved" : "declined"} by ${r.approval.by} (${r.approval.reason})`);
      approvals.push(r.approval);
      printEnvelope(r.turn.tool, r.envelope);
      if (r.turn.tool === "execute" && r.envelope?.ok && (r.envelope.result as { status?: string }).status === "executed") {
        const p = host.prepared.find((x) => x.intent.intent_id === r.turn.args.intent_id);
        const spent = p ? usdValue(rt.chain, String(p.input.sell_token), String(p.input.sell_amount), rt.usd) : null;
        if (spent !== null) rt.ledger.add(spent);
      }
    });
  }

  // Report the intents the server actually prepared, in order.
  const overAmount = (() => {
    const over = ideas.find((i) => i.demo_refusal);
    return over ? swapInput(rt, cfg, over).sell_amount : null;
  })();
  const reports: IntentReport[] = [];
  const handOffItems: HandOffItem[] = [];
  let demoRefused = false;
  let ownAllowed = false;
  for (const p of host.prepared) {
    const demo = overAmount !== null && p.input.sell_amount === overAmount;
    const idea = ideas.find((i) => swapInput(rt, cfg, i).sell_amount === p.input.sell_amount);
    reports.push(intentReport(idea?.label ?? `prepared ${String(p.input.sell_amount)} base units`, demo, p.intent));
    handOffItems.push({ label: reports[reports.length - 1].label, intent: p.intent });
    if (demo && !p.intent.policy.ok && p.intent.policy.refusals.length > 0) demoRefused = true;
    if (!demo && p.intent.policy.ok) ownAllowed = true;
  }
  const executed = approvals.some((a) => a.tool === "execute" && a.approved);

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
    model: modelName,
    host: { framework: "claude-agent-sdk", server: SERVER_NAME, tools: toolNames, hook_matcher: HOOK_MATCHER, approvals },
    venue: cfg.venue,
    market,
    intents: reports,
    ...(satoOs ? { sato_os: satoOs } : {}),
    executed,
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
  console.log(satoOs ? "Nothing was signed or sent from here; allowed intents wait in Sato OS for a person's approval." : executed ? "" : "Nothing was signed, sent or spent.");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`\nStopped: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(e instanceof UsageError ? 2 : 1);
  },
);

