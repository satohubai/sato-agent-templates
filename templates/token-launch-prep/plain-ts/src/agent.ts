// Prepare a Clanker v4 token deploy on Base, simulate it, write it down.
//
//   config.json (schemas/input.json) -> the unsigned deployToken transaction ->
//   a summary decoded from its calldata -> tx.simulate through the Sato Kit ->
//   out/report.json (schemas/output.json).
//
// It holds no key, signs nothing and sends nothing, in every mode. You sign the
// transaction yourself, in your own wallet, if you choose to launch.
//
//   npm start -- --mode fixture            config.json + fixtures/scenarios/*.input.json, recorded RPC, no network
//   npm start -- --mode fork               ANVIL_RPC_URL (a local anvil fork of Base)
//   npm start -- --mode rpc --rpc <url>    an RPC you name (Base or Base Sepolia), read-only calls

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ConfigError, parseArgs, parseLaunchInput, UsageError } from "./config.js";
import { writeRpcFixtures } from "./fixtures.js";
import { prepareLaunch, type LaunchReport } from "./launch.js";
import { loadPolicy } from "./policy.js";
import { buildRuntime, USER_AGENT } from "./runtime.js";

const FIXTURES_DIR = "fixtures";
const SCENARIOS_DIR = join(FIXTURES_DIR, "scenarios");
const inputSchema = JSON.parse(readFileSync(new URL("../schemas/input.json", import.meta.url), "utf8"));

function print(name: string, r: LaunchReport): void {
  console.log(`\n${name} (source_kind=${r.source_kind})`);
  for (const l of r.summary.lines) console.log(`  - ${l}`);
  console.log(`  unsigned tx: to ${r.unsigned_tx.to}, chain id ${r.unsigned_tx.chain_id}, value ${r.unsigned_tx.value}, data ${r.unsigned_tx.data.length / 2 - 1} bytes`);
  const s = r.simulation;
  console.log(
    s.ok
      ? `  simulation: ok at block ${s.block}, gas estimate ${s.gas_estimate}, predicted token ${s.predicted_token_address ?? "not read"}`
      : `  simulation: NOT OK at block ${s.block ?? "unknown"}: ${s.error}${s.revert_name ? ` (${s.revert_name})` : ""}`,
  );
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), process.env);
  const policy = loadPolicy(args.policy);
  console.log(`token-launch-prep — mode ${args.mode}`);
  console.log("Prepares and simulates an unsigned Clanker v4 deploy. It holds no key, signs nothing and sends nothing.");
  console.log(`  user-agent         ${USER_AGENT}`);

  const rt = await buildRuntime({ mode: args.mode, policy, fixturesDir: FIXTURES_DIR, env: process.env, rpcUrl: args.rpc, record: args.record });
  const input = parseLaunchInput(JSON.parse(readFileSync(args.config, "utf8")), inputSchema, args.config);
  const report = await prepareLaunch(input, rt);
  print(args.config, report);
  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  let failed = report.simulation.ok ? 0 : 1;

  if (args.mode === "fixture" || args.record) {
    // The recorded scenarios: each is { _note, input } and replays the same RPC recordings.
    mkdirSync(join(args.out, "scenarios"), { recursive: true });
    for (const f of readdirSync(SCENARIOS_DIR).filter((x) => x.endsWith(".input.json")).sort()) {
      const doc = JSON.parse(readFileSync(join(SCENARIOS_DIR, f), "utf8")) as { input: unknown };
      const r = await prepareLaunch(parseLaunchInput(doc.input, inputSchema, f), rt);
      print(f, r);
      if (!r.simulation.ok) failed += 1;
      writeFileSync(join(args.out, "scenarios", `${basename(f, ".input.json")}.output.json`), JSON.stringify(r, null, 2) + "\n");
    }
  }

  if (args.record && rt.recorded) {
    writeRpcFixtures(FIXTURES_DIR, rt.recorded, { recorded_from: "anvil fork of Base at block 51800000", note: "written by --mode fork --record" });
    console.log(`\nRecorded ${Object.keys(rt.recorded).length} RPC answer(s) into ${FIXTURES_DIR}/rpc.json`);
  }
  console.log(`\nReport written to ${join(args.out, "report.json")}. Nothing was signed or sent.`);
  console.log(`\n${report.caveat}`);
  if (failed) console.error(`\n${failed} simulation(s) did not pass; see the report. Do not sign a transaction whose simulation did not pass.`);
  return failed ? 3 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`\nStopped: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(e instanceof UsageError || e instanceof ConfigError ? 2 : 1);
  },
);
