// Every scenario through the real task path: kit chain.read over the recorded
// RPC answers, the FAKE provider, and the gate. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveChainReads } from "../src/chain.js";
import { validateConfig } from "../src/config.js";
import { loadPolicy } from "../src/policy.js";
import { fakeAdapter } from "../src/providers.js";
import { buildRuntime } from "../src/runtime.js";
import { runTask, type ReportInput, type ReportOutput } from "../src/task.js";

const inputSchema = JSON.parse(readFileSync("schemas/input.json", "utf8"));
const outputSchema = JSON.parse(readFileSync("schemas/output.json", "utf8"));
type Scenario = { input: ReportInput; fixture?: { model_response?: unknown } };
const load = (name: string) => JSON.parse(readFileSync(join("fixtures/scenarios", `${name}.input.json`), "utf8")) as Scenario;

async function run(doc: Scenario): Promise<ReportOutput> {
  const rt = await buildRuntime({ mode: "fixture", policy: loadPolicy("policy.json"), fixturesDir: "fixtures", env: {} });
  const chain = await resolveChainReads(rt.kit, doc.input.chain_reads ?? [], rt.chains);
  return runTask(doc.input, fakeAdapter(doc.fixture?.model_response), chain, { now: new Date(rt.clock()).toISOString(), source_kind: rt.mode });
}

test("every scenario and config.json are valid input and produce valid output", async () => {
  assert.deepEqual(validateConfig(JSON.parse(readFileSync("config.json", "utf8")), inputSchema), []);
  for (const f of readdirSync("fixtures/scenarios").filter((x) => x.endsWith(".input.json"))) {
    const doc = JSON.parse(readFileSync(join("fixtures/scenarios", f), "utf8")) as Scenario;
    assert.deepEqual(validateConfig(doc.input, inputSchema, f), []);
    const out = await run(doc);
    assert.deepEqual(validateConfig(out, outputSchema, "output"), [], f);
    assert.equal(out.provider, "fake");
  }
});

test("chain reads become cited sources with the exact value; a rounded value is rejected", async () => {
  const out = await run(load("chain-read-cited"));
  assert.deepEqual(out.chain_reads.map((r) => [r.id, r.ok, r.block_number]), [["c1", true, "51800000"], ["c2", true, "51800000"]]);
  assert.match(out.chain_reads[0].detail, /returned 4303897166696938 base units/);
  assert.match(out.chain_reads[1].detail, /returned 25896806146 base units/);
  assert.equal(out.findings.length, 2);
  assert.deepEqual(out.rejected.map((r) => [r.reason, r.detail]), [["unsupported_number", "the value(s) 26000 do not appear in any cited source"]]);
  assert.deepEqual(out.sources_supplied, ["c1", "c2", "s1"]);
  assert.deepEqual(out.sources_used, ["c1", "c2", "s1"]);
});

test("a read this run cannot make is an unknown, and citing it is an unknown source", async () => {
  const out = await run(load("chain-read-unavailable"));
  assert.equal(out.chain_reads[0].ok, false);
  assert.equal(out.findings.length, 0);
  assert.equal(out.rejected[0].reason, "unknown_source");
  assert.ok(out.unknowns.some((u) => /chain read c1/.test(u.question)));
});

test("fabrications are rejected with their reasons and never reach sources_used", async () => {
  const out = await run(load("invented-source-and-amount"));
  assert.deepEqual(out.rejected.map((r) => r.reason), ["unknown_source", "unsupported_number"]);
  assert.deepEqual(out.sources_used, ["s2"]);
});

test("supported findings survive and a two-source disagreement is a conflict", async () => {
  const out = await run(load("supported-and-conflicting"));
  assert.equal(out.findings.length, 2);
  assert.equal(out.conflicts.length, 1);
  assert.equal(out.unknowns.length, 1);
});

test("an unusable model reply is a recorded failure, never an empty success", async () => {
  const out = await run(load("unusable-model-output"));
  assert.equal(out.findings.length, 0);
  assert.equal(out.unknowns.length, 1);
});

test("a corpus that establishes nothing yields unknowns, not padded findings", async () => {
  const out = await run(load("everything-unknown"));
  assert.equal(out.findings.length, 0);
  assert.equal(out.unknowns.length, 2);
});
