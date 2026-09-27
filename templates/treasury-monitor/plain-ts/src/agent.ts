// One pass of the treasury monitor:
//   read each (address, asset) through the kit's chain.read -> value what has
//   a named price -> evaluate thresholds against the checkpoint -> report.
//
// It holds no key, signs nothing and moves no funds, in every mode.
//
//   npm start -- --mode fixture            config.json + fixtures/scenarios/*.input.json, recorded RPC, no network
//   npm start -- --mode fork               ANVIL_RPC_URL (a local fork of Base)
//   npm start -- --mode rpc --rpc <url>    an RPC you name, read-only

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ConfigError, loadCheckpoint, parseArgs, requireValidConfig, saveCheckpoint, UsageError } from "./config.js";
import { writeRpcFixtures } from "./fixtures.js";
import { loadPolicy } from "./policy.js";
import { buildRuntime, USER_AGENT, type Runtime } from "./runtime.js";
import { kitSource } from "./sources.js";
import { runTask, type MonitorInput, type MonitorOutput } from "./task.js";

const FIXTURES_DIR = "fixtures";
const SCENARIOS_DIR = join(FIXTURES_DIR, "scenarios");
const inputSchema = JSON.parse(readFileSync(new URL("../schemas/input.json", import.meta.url), "utf8"));

function line(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(18)} ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

async function monitor(rt: Runtime, input: MonitorInput): Promise<MonitorOutput> {
  return runTask(input, kitSource(rt.mode, rt.kit, rt.chains), new Date(rt.clock()).toISOString());
}

function print(name: string, out: MonitorOutput): void {
  console.log(`\n${name} (source_kind=${out.source_kind}${out.read_at.map((r) => `, ${r.chain} block ${r.block_number}`).join("")})`);
  for (const b of out.balances) line(`${b.address_label} ${b.asset}`, `${b.native} (${b.base_units} base units)${b.value_usd === null ? "" : ` ≈ ${b.value_usd} USD from ${b.price_source}`}`);
  line("total_usd", out.total_usd === null ? "null (not every holding is priced, or nothing was read)" : out.total_usd);
  for (const a of out.alerts) console.log(`  ALERT ${a.address_label} ${a.asset} ${a.direction} ${a.threshold_base_units}: observed ${a.observed_base_units}`);
  for (const u of out.unknowns) console.log(`  unknown ${u.kind}: ${u.detail}`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), process.env);
  const policy = loadPolicy(args.policy);
  console.log(`treasury-monitor — mode ${args.mode}`);
  console.log("Reads only, through the Sato Kit's chain.read. It holds no key, signs nothing and moves no funds.");
  line("user-agent", USER_AGENT);

  const rt = await buildRuntime({ mode: args.mode, policy, fixturesDir: FIXTURES_DIR, env: process.env, rpcUrl: args.rpc, record: args.record });
  const checkpoint = loadCheckpoint(args.checkpoint);
  const config = requireValidConfig<MonitorInput>(JSON.parse(readFileSync(args.config, "utf8")), inputSchema, args.config);
  const main = await monitor(rt, checkpoint ? { ...config, checkpoint } : config);
  print(args.config, main);
  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, "report.json"), JSON.stringify(main, null, 2) + "\n");
  saveCheckpoint(args.checkpoint, main.checkpoint);

  if (args.mode === "fixture" || args.record) {
    // The recorded scenarios: each is { _note, input } and replays the same RPC recordings.
    mkdirSync(join(args.out, "scenarios"), { recursive: true });
    for (const f of readdirSync(SCENARIOS_DIR).filter((x) => x.endsWith(".input.json")).sort()) {
      const doc = JSON.parse(readFileSync(join(SCENARIOS_DIR, f), "utf8")) as { input: unknown };
      const input = requireValidConfig<MonitorInput>(doc.input, inputSchema, f);
      const out = await monitor(rt, input);
      print(f, out);
      writeFileSync(join(args.out, "scenarios", `${basename(f, ".input.json")}.output.json`), JSON.stringify(out, null, 2) + "\n");
    }
  }

  if (args.record && rt.recorded) {
    writeRpcFixtures(FIXTURES_DIR, rt.recorded, { recorded_from: "anvil fork of Base at block 51800000", note: "written by --mode fork --record" });
    console.log(`\nRecorded ${Object.keys(rt.recorded).length} RPC answer(s) into ${FIXTURES_DIR}/rpc.json`);
  }
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
