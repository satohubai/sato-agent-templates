import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const tpl = JSON.parse(readFileSync("sato.template.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));

test("package.json pins exact versions only", () => {
  for (const deps of [pkg.dependencies, pkg.devDependencies]) {
    for (const [name, v] of Object.entries(deps as Record<string, string>)) {
      assert.ok(/^\d+\.\d+\.\d+$/.test(v) || v.startsWith("file:vendor/"), `${name}@${v}`);
    }
  }
});

test("sato.template.json upstream pins match the lockfile", () => {
  for (const [name, v] of Object.entries(tpl.template.upstream as Record<string, string>)) {
    assert.equal(lock.packages[`node_modules/${name}`]?.version, v, name);
  }
});

test("sato.template.json policy_defaults match policy.json", () => {
  const policy = JSON.parse(readFileSync("policy.json", "utf8"));
  for (const [k, v] of Object.entries(tpl.template.policy_defaults)) assert.deepEqual(policy[k], v, k);
});

test("the fixture command in the template is the one CI runs", () => {
  assert.deepEqual(tpl.harness.fixture_command, ["npm", "start", "--", "--mode", "fixture"]);
  assert.equal(tpl.network.test, "none");
});

test("this is the OpenAI Agents SDK build of base-guarded-trader", () => {
  assert.equal(tpl.id, "base-guarded-trader");
  assert.equal(tpl.template.framework, "openai-agents");
  assert.deepEqual(tpl.template.intents, ["trading", "swap"]);
  assert.deepEqual(tpl.template.chains, ["base", "base-sepolia"]);
  assert.ok(!tpl.template.networks.includes("mainnet"));
  assert.ok(tpl.declared_secret_names.includes("OPENAI_API_KEY"));
});
