// End to end: the default command a generated repo is judged by, and its
// output checked against schemas/output.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../src/config.js";

const outputSchema = JSON.parse(readFileSync("schemas/output.json", "utf8"));

test("npm start -- --mode fixture exits 0 offline and writes reports that match schemas/output.json", () => {
  const out = mkdtempSync(join(tmpdir(), "tlp-"));
  // No RPC variable at all: fixture mode must not need the network.
  const env = { ...process.env, ANVIL_RPC_URL: "", SATO_RPC_URL_BASE: "" };
  const r = spawnSync("npm", ["start", "--silent", "--", "--mode", "fixture", "--out", out], { encoding: "utf8", timeout: 120_000, env });
  const text = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 0, text);
  assert.match(text, /holds no key, signs nothing and sends nothing/);
  assert.match(text, /Nothing was signed or sent/);
  assert.match(text, /simulation: ok at block 51800000/);

  const reports = [join(out, "report.json"), ...readdirSync(join(out, "scenarios")).map((f) => join(out, "scenarios", f))];
  assert.equal(reports.length, 1 + readdirSync("fixtures/scenarios").filter((f) => f.endsWith(".input.json")).length);
  for (const f of reports) {
    const rep = JSON.parse(readFileSync(f, "utf8"));
    assert.deepEqual(validateConfig(rep, outputSchema, "report"), [], f);
    assert.equal(rep.signed, false);
    assert.equal(rep.broadcast, false);
    assert.equal(rep.source_kind, "fixture");
    assert.equal(rep.generated_at, "2026-10-06T00:00:00.000Z");
    assert.equal(rep.simulation.ok, true, f);
    assert.equal(rep.simulation.block, "51800000");
    assert.match(rep.simulation.predicted_token_address, /^0x[0-9a-fA-F]{40}$/);
    assert.equal(rep.unsigned_tx.value, "0");
    assert.equal(rep.summary.rewards.total_bps, 10000);
    assert.deepEqual(rep.summary.rewards.recipients.map((x: { recipient: string }) => x.recipient), [rep.summary.token.admin]);
    assert.match(rep.caveat, /Nothing here is investment advice/);
  }

  const main = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
  assert.equal(main.simulation.predicted_token_address, "0xe5BB4Cc592F55D913f4f1990D02403D03DD80B31");
  assert.equal(main.simulation.gas_estimate, "4195005");
  const salted = JSON.parse(readFileSync(join(out, "scenarios", "custom-salt.output.json"), "utf8"));
  assert.notEqual(salted.simulation.predicted_token_address, main.simulation.predicted_token_address, "a different salt yields a different address");
  const project = JSON.parse(readFileSync(join(out, "scenarios", "project-preset.output.json"), "utf8"));
  assert.equal(project.summary.pool.positions.length, 5);
  assert.equal(project.simulation.simulated_from, "0x2222222222222222222222222222222222222222");
});

test("a report that claims it was signed or broadcast does not match the schema", () => {
  const out = mkdtempSync(join(tmpdir(), "tlp-"));
  const r = spawnSync("npm", ["start", "--silent", "--", "--mode", "fixture", "--out", out], { encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  const rep = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
  assert.ok(validateConfig({ ...rep, signed: true }, outputSchema).some((e) => /signed must be false/.test(e)));
  assert.ok(validateConfig({ ...rep, broadcast: true }, outputSchema).some((e) => /broadcast must be false/.test(e)));
  assert.ok(validateConfig({ ...rep, unsigned_tx: { ...rep.unsigned_tx, value: "1" } }, outputSchema).some((e) => /value must be "0"/.test(e)));
});
