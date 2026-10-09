// End to end: the default command a generated repo is judged by.
// Depends on the kit's real implementation (actions, pre-flight, intents).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTransaction } from "@satohub/kit";
import { FIXTURE_WALLET } from "../src/runtime.js";
import { templatePolicyFile } from "./helpers.js";

const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

test("npm start -- --mode fixture exits 0, names its refusals, and stops at an unsigned transaction", () => {
  const out = mkdtempSync(join(tmpdir(), "sgs-"));
  const r = spawnSync("npm", ["start", "--silent", "--", "--mode", "fixture", "--out", out, "--policy", templatePolicyFile()], { encoding: "utf8", timeout: 120_000, env: { ...process.env, SOLANA_RPC_URL: "" } });
  const text = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 0, text);
  assert.match(text, /REFUSED rule=max_usd_per_day limit=20 observed=\S+/);
  assert.match(text, /REFUSED rule=max_usd_per_trade limit=15 observed=\S+/);
  assert.match(text, /The kit's pre-flight explains every refusal/);
  assert.match(text, /signer\s+none — this template holds no key/);
  assert.match(text, /Nothing was signed, sent or spent/);

  const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
  assert.equal(report.signed, false);
  assert.equal(report.broadcast, false);
  assert.equal(report.watch.fired, true);
  const demo = report.intents.filter((i: { demo_refusal: boolean }) => i.demo_refusal);
  assert.equal(demo.length, 2);
  for (const d of demo) {
    assert.equal(d.policy_ok, false);
    assert.ok(d.refusals.length > 0 && d.refusals.every((x: { rule: string; limit: string; observed: string }) => x.rule && x.limit && x.observed));
    assert.equal(d.handoff_file, null);
  }
  const own = report.intents.find((i: { demo_refusal: boolean }) => !i.demo_refusal);
  assert.equal(own.policy_ok, true);
  assert.equal(own.simulation.ok, true);
  assert.equal(own.simulation.method, "simulateTransaction");

  // Exactly one file to sign, and it is a real Solana transaction with no signature on it.
  assert.deepEqual(readdirSync(out).filter((f) => f.startsWith("unsigned-")), ["unsigned-1.json"]);
  const file = JSON.parse(readFileSync(join(out, "unsigned-1.json"), "utf8"));
  assert.equal(file.signed, false);
  const bytes = Buffer.from(file.transaction_base64, "base64");
  const tx = readTransaction(new Uint8Array(bytes));
  assert.equal(tx.fee_payer, FIXTURE_WALLET);
  assert.equal(tx.recent_blockhash, file.recent_blockhash);
  assert.ok(tx.account_keys.includes(JUPITER_V6), "the transaction calls the Jupiter program");
  assert.equal(tx.signatures, 1, "one signature slot, the fee payer's");
  assert.ok(bytes.subarray(1, 65).every((b) => b === 0), "the signature slot is empty: nobody has signed");
});

test("fixture mode never reaches the network: an unrecorded request throws", () => {
  const out = mkdtempSync(join(tmpdir(), "sgs-"));
  const cfg = join(out, "config.json");
  // 0.2 SOL was never recorded.
  writeFileSync(cfg, JSON.stringify({ sell_sol: "0.2" }));
  const r = spawnSync("npm", ["start", "--silent", "--", "--mode", "fixture", "--out", out, "--config", cfg], { encoding: "utf8", timeout: 120_000 });
  assert.notEqual(r.status, 0);
  assert.match(`${r.stdout}\n${r.stderr}`, /fixture mode: no recorded response for GET https:\/\/lite-api\.jup\.ag\/swap\/v1\/quote/);
});
