// One research report:
//   make the input's onchain reads through the kit's chain.read -> hand the
//   model the closed corpus -> put its proposal through the gate -> report.
//
// It holds no key, signs nothing and moves no funds, in every mode.
//
//   npm start -- --mode fixture                 every fixtures/scenarios/*.input.json with the FAKE provider
//                                               and recorded RPC answers; no network, no key
//   npm start -- --mode fork                    config.json; ANVIL_RPC_URL; the real provider (ANTHROPIC_API_KEY)
//   npm start -- --mode rpc --rpc <url>         config.json; an RPC you name; the real provider
//
// Fixture mode ALWAYS uses the fake provider, whether or not a key is set: a
// test lane that silently becomes a paid call is a lane nobody can trust.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { resolveChainReads } from "./chain.js";
import { ConfigError, parseArgs, requireValidConfig, UsageError } from "./config.js";
import { writeRpcFixtures } from "./fixtures.js";
import { loadPolicy } from "./policy.js";
import { fakeAdapter, realAdapter, type ModelAdapter } from "./providers.js";
import { buildRuntime, USER_AGENT, type Runtime } from "./runtime.js";
import { runTask, type ReportInput, type ReportOutput } from "./task.js";

const FIXTURES_DIR = "fixtures";
const SCENARIOS_DIR = join(FIXTURES_DIR, "scenarios");
const inputSchema = JSON.parse(readFileSync(new URL("../schemas/input.json", import.meta.url), "utf8"));

type Scenario = { _note?: string; input: unknown; fixture?: { model_response?: unknown } };

function line(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(14)} ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

async function report(rt: Runtime, input: ReportInput, adapter: ModelAdapter): Promise<ReportOutput> {
  const chain = await resolveChainReads(rt.kit, input.chain_reads ?? [], rt.chains);
  return runTask(input, adapter, chain, { now: new Date(rt.clock()).toISOString(), source_kind: rt.mode });
}

function print(name: string, out: ReportOutput): void {
  console.log(`\n${name} (provider=${out.provider}, source_kind=${out.source_kind})`);
  for (const r of out.chain_reads) line(`read ${r.id}`, r.ok ? r.detail : `unknown — ${r.detail}`);
  for (const f of out.findings) line("finding", `${f.statement} [${f.source_ids.join(", ")}]`);
  for (const r of out.rejected) line("REJECTED", `${r.reason}: ${r.statement} — ${r.detail}`);
  for (const c of out.conflicts) line("conflict", `${c.topic} [${c.source_ids.join(", ")}]`);
  for (const u of out.unknowns) line("unknown", `${u.question} — ${u.reason}`);
}

async function runScenarios(rt: Runtime, outDir: string): Promise<Map<string, ReportOutput>> {
  const results = new Map<string, ReportOutput>();
  mkdirSync(join(outDir, "scenarios"), { recursive: true });
  for (const f of readdirSync(SCENARIOS_DIR).filter((x) => x.endsWith(".input.json")).sort()) {
    const doc = JSON.parse(readFileSync(join(SCENARIOS_DIR, f), "utf8")) as Scenario;
    const input = requireValidConfig<ReportInput>(doc.input, inputSchema, f);
    const out = await report(rt, input, fakeAdapter(doc.fixture?.model_response));
    const name = basename(f, ".input.json");
    results.set(name, out);
    print(f, out);
    writeFileSync(join(outDir, "scenarios", `${name}.output.json`), JSON.stringify(out, null, 2) + "\n");
  }
  return results;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), process.env);
  const policy = loadPolicy(args.policy);
  console.log(`research-report — mode ${args.mode}`);
  console.log("A model proposes; a deterministic gate decides. Onchain reads go through the Sato Kit's chain.read. It holds no key, signs nothing and moves no funds.");
  line("user-agent", USER_AGENT);

  const rt = await buildRuntime({ mode: args.mode, policy, fixturesDir: FIXTURES_DIR, env: process.env, rpcUrl: args.rpc, record: args.record });
  mkdirSync(args.out, { recursive: true });

  if (args.mode === "fixture" || args.record) {
    const results = await runScenarios(rt, args.out);
    const main = results.get(args.scenario);
    if (!main) throw new UsageError(`no scenario ${JSON.stringify(args.scenario)} in ${SCENARIOS_DIR}`);
    writeFileSync(join(args.out, "report.json"), JSON.stringify(main, null, 2) + "\n");
    if (args.record && rt.recorded) {
      writeRpcFixtures(FIXTURES_DIR, rt.recorded, { recorded_from: "anvil fork of Base at block 51800000", note: "written by --mode fork --record" });
      console.log(`\nRecorded ${Object.keys(rt.recorded).length} RPC answer(s) into ${FIXTURES_DIR}/rpc.json`);
    }
    console.log(`\nReport (scenario ${args.scenario}) written to ${join(args.out, "report.json")}. Fake provider; nothing was signed, sent or spent.`);
    return 0;
  }

  const input = requireValidConfig<ReportInput>(JSON.parse(readFileSync(args.config, "utf8")), inputSchema, args.config);
  const resolved = realAdapter({ model: args.model, env: process.env, userAgent: USER_AGENT });
  if (!resolved.ok) {
    console.error(JSON.stringify({ error: "unsupported", reason_code: resolved.reason_code, detail: resolved.detail }, null, 2));
    return 3;
  }
  const out = await report(rt, input, resolved.adapter);
  print(args.config, out);
  writeFileSync(join(args.out, "report.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`\nReport written to ${join(args.out, "report.json")}. Nothing was signed, sent or spent.`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`\nStopped: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(e instanceof UsageError || e instanceof ConfigError ? 2 : 1);
  },
);
