// x402-seller: a small HTTP API behind x402.
//
//   npm start -- --mode fixture   the default: replays fixtures/scenarios/*.json
//                                 through the payment gate in-process (no
//                                 network, no key, FakeFacilitator), writes
//                                 out/report.json and out/listing.json
//   npm start -- --mode fork      serves on --port (4021) against a local anvil
//                                 fork of Base (ANVIL_RPC_URL)
//   npm start -- --mode testnet   serves on --port against Base Sepolia through
//                                 the facilitator named in config.json
//
// The seller holds no key, signs nothing and publishes nothing, in every mode.

import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ConfigError, parseArgs, requireValidConfig, UsageError, type SellerConfig } from "./config.js";
import { buildListing } from "./listing.js";
import { loadPolicy } from "./policy.js";
import { buildRuntime, USER_AGENT, type Runtime } from "./runtime.js";
import { handle, serve, type GateRequest, type GateResponse } from "./server.js";
import { decodeHeader, encodeHeader, HEADER_PAYMENT, HEADER_REQUIRED, HEADER_RESPONSE, type PaymentPayload } from "./x402.js";

const FIXTURES_DIR = "fixtures";

export type Scenario = {
  _note: string;
  request: { method: string; path: string; query: Record<string, string>; payment?: string };
  expect: { status: number; reason?: string };
};

export type ScenarioResult = {
  id: string;
  note: string;
  request: { method: string; path: string; query: Record<string, string>; payment: string | null };
  status: number;
  refused_reason: string | null;
  payment_required: unknown;
  payment_response: unknown;
  receipt: GateResponse["receipt"] | null;
  body: unknown;
  expected: Scenario["expect"];
  as_expected: boolean;
};

export function loadPayment(dir: string, id: string): PaymentPayload {
  const doc = JSON.parse(readFileSync(join(dir, "payments", `${id}.json`), "utf8")) as { payload: PaymentPayload };
  return doc.payload;
}

export async function runScenario(rt: Runtime, config: SellerConfig, id: string, s: Scenario, fixturesDir = FIXTURES_DIR): Promise<ScenarioResult> {
  const headers: GateRequest["headers"] = {};
  if (s.request.payment) headers[HEADER_PAYMENT] = encodeHeader(loadPayment(fixturesDir, s.request.payment));
  const out = await handle({ method: s.request.method, path: s.request.path, query: s.request.query, headers }, { config, net: rt.net, facilitator: rt.facilitator, kit: rt.kit, nowMs: rt.nowMs });
  const body = out.body as { refused?: { reason?: string } } | null;
  const refused = out.status === 402 ? body?.refused?.reason ?? null : null;
  return {
    id,
    note: s._note,
    request: { ...s.request, payment: s.request.payment ?? null },
    status: out.status,
    refused_reason: refused,
    payment_required: out.headers[HEADER_REQUIRED] ? decodeHeader(out.headers[HEADER_REQUIRED]) : null,
    payment_response: out.headers[HEADER_RESPONSE] ? decodeHeader(out.headers[HEADER_RESPONSE]) : null,
    receipt: out.receipt ?? null,
    body: out.body,
    expected: s.expect,
    as_expected: out.status === s.expect.status && (s.expect.reason ?? null) === refused,
  };
}

async function fixtureRun(rt: Runtime, config: SellerConfig, outDir: string): Promise<number> {
  const dir = join(FIXTURES_DIR, "scenarios");
  const results: ScenarioResult[] = [];
  // Scenarios run in file-name order against ONE facilitator, so a replayed
  // payment meets the nonce its first use settled.
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const s = JSON.parse(readFileSync(join(dir, f), "utf8")) as Scenario;
    const r = await runScenario(rt, config, basename(f, ".json"), s);
    results.push(r);
    const extra = r.refused_reason ? ` refused: ${r.refused_reason}` : r.receipt ? ` settled ${r.receipt.amount} base units, ${r.receipt.confirmation.status} at block ${r.receipt.confirmation.block_number}` : "";
    console.log(`${r.as_expected ? "ok  " : "DIFF"} ${r.id.padEnd(28)} ${r.request.method} ${r.request.path} -> ${r.status}${extra}`);
  }
  const listing = buildListing(config, rt.net, rt.mode, new Date(rt.nowMs()).toISOString());
  const report = {
    schema: "sato.x402-seller.report/v1",
    template: "x402-seller",
    mode: rt.mode,
    network: rt.net.network,
    facilitator: rt.facilitator.kind,
    generated_at: new Date(rt.nowMs()).toISOString(),
    all_as_expected: results.every((r) => r.as_expected),
    scenarios: results,
    listing_file: "listing.json",
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(outDir, "listing.json"), JSON.stringify(listing, null, 2) + "\n");
  console.log(`\nReport: ${join(outDir, "report.json")}. Listing (not submitted): ${join(outDir, "listing.json")}.`);
  console.log("Fixture mode: FakeFacilitator, recorded chain reads. Nothing was signed by the seller, sent or published.");
  return report.all_as_expected ? 0 : 1;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const policy = loadPolicy(args.policy);
  const config = requireValidConfig(JSON.parse(readFileSync(args.config, "utf8")) as SellerConfig, args.config, args.mode);
  console.log(`x402-seller — mode ${args.mode}`);
  console.log("Receives x402 payments through a facilitator. It holds no key, signs nothing and publishes nothing.");
  console.log(`  user-agent ${USER_AGENT}\n`);
  const rt = await buildRuntime({ mode: args.mode, policy, config, fixturesDir: FIXTURES_DIR, env: process.env });
  if (args.mode === "fixture") return fixtureRun(rt, config, args.out);

  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, "listing.json"), JSON.stringify(buildListing(config, rt.net, rt.mode, new Date().toISOString()), null, 2) + "\n");
  const server = serve({ config, net: rt.net, facilitator: rt.facilitator, kit: rt.kit, nowMs: rt.nowMs }, args.port, (r) => {
    appendFileSync(join(args.out, "receipts.jsonl"), JSON.stringify(r) + "\n");
    console.log(`settled ${r.amount} base units from ${r.payer} in ${r.transaction} (${r.confirmation.status})`);
  });
  console.log(`Serving on http://localhost:${args.port} (${rt.net.network}, facilitator ${rt.facilitator.kind}). Ctrl-C stops it.`);
  for (const r of config.routes) console.log(`  ${r.method} ${r.path} costs ${r.price_base_units} base units of ${rt.net.asset_symbol}`);
  console.log(`Listing written to ${join(args.out, "listing.json")} (not submitted).`);
  await new Promise<void>((resolve) => process.once("SIGINT", () => server.close(() => resolve())));
  return 0;
}

if (process.argv[1] && basename(process.argv[1]) === "agent.ts") {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`\nStopped: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(e instanceof UsageError || e instanceof ConfigError ? 2 : 1);
    },
  );
}
