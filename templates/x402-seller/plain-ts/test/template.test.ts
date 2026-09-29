import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const tpl = JSON.parse(readFileSync("sato.template.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));

test("package.json pins exact versions only", () => {
  for (const deps of [pkg.dependencies, pkg.devDependencies]) {
    for (const [name, v] of Object.entries(deps as Record<string, string>)) assert.ok(/^\d+\.\d+\.\d+$/.test(v) || v.startsWith("file:vendor/"), `${name}@${v}`);
  }
});

const PIN_CHECK_SKIP = process.env.SATO_LANE === "latest" ? "SATO_LANE=latest: the latest lane changes versions on purpose; pin consistency is checked on the pinned lane" : false;

test("sato.template.json upstream pins match the lockfile", { skip: PIN_CHECK_SKIP }, () => {
  for (const [name, v] of Object.entries(tpl.template.upstream as Record<string, string>)) assert.equal(lock.packages[`node_modules/${name}`]?.version, v, name);
});

test("sato.template.json policy_defaults match policy.json", () => {
  const policy = JSON.parse(readFileSync("policy.json", "utf8"));
  for (const [k, v] of Object.entries(tpl.template.policy_defaults)) assert.deepEqual(policy[k], v, k);
});

test("the fixture command in the template is the one CI runs; no mainnet network", () => {
  assert.deepEqual(tpl.harness.fixture_command, ["npm", "start", "--", "--mode", "fixture"]);
  assert.equal(tpl.network.test, "none");
  assert.ok(!tpl.template.networks.includes("mainnet"));
  assert.deepEqual(tpl.template.intents, ["payments"]);
});

test("the seller never signs: src holds no key, no signing call and no kit write", () => {
  for (const f of readdirSync("src")) {
    const s = readFileSync(`src/${f}`, "utf8");
    assert.doesNotMatch(s, /\.prepare\(|\.execute\(|signTypedData|privateKey|PRIVATE_KEY|generatePrivateKey|mnemonic/i, f);
  }
  const env = readFileSync(".env.example", "utf8");
  assert.doesNotMatch(env, /KEY=|MNEMONIC=/);
});

test("the only eth_sendTransaction is the fork facilitator, and it refuses a chain id other than the requirements'", () => {
  const hits = readdirSync("src").filter((f) => readFileSync(`src/${f}`, "utf8").includes("eth_sendTransaction"));
  assert.deepEqual(hits, ["facilitator.ts"]);
  assert.match(readFileSync("src/facilitator.ts", "utf8"), /fork facilitator: RPC answers chain id/);
});

test("README and AGENTS carry a 'What it does NOT do' section", () => {
  assert.match(readFileSync("README.md", "utf8"), /## What it does NOT do/);
  assert.match(readFileSync("AGENTS.md", "utf8"), /## What it does NOT do/);
});
