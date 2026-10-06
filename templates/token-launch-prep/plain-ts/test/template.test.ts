import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const tpl = JSON.parse(readFileSync("sato.template.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));

test("package.json pins exact versions only", () => {
  for (const deps of [pkg.dependencies, pkg.devDependencies]) {
    for (const [name, v] of Object.entries(deps as Record<string, string>)) assert.ok(/^\d+\.\d+\.\d+$/.test(v) || v.startsWith("file:vendor/"), `${name}@${v}`);
  }
});

// The latest lane (SATO_LANE=latest) moves versions on purpose, so pin
// consistency is only meaningful on the pinned lane.
const PIN_CHECK_SKIP = process.env.SATO_LANE === "latest" ? "SATO_LANE=latest: the latest lane changes versions on purpose; pin consistency is checked on the pinned lane" : false;

test("sato.template.json upstream pins match the lockfile", { skip: PIN_CHECK_SKIP }, () => {
  for (const [name, v] of Object.entries(tpl.template.upstream as Record<string, string>)) assert.equal(lock.packages[`node_modules/${name}`]?.version, v, name);
});

test("sato.template.json policy_defaults match policy.json", () => {
  const policy = JSON.parse(readFileSync("policy.json", "utf8"));
  for (const [k, v] of Object.entries(tpl.template.policy_defaults)) assert.deepEqual(policy[k], v, k);
});

test("the fixture command in the template is the one CI runs", () => {
  assert.deepEqual(tpl.harness.fixture_command, ["npm", "start", "--", "--mode", "fixture"]);
  assert.equal(tpl.network.test, "none");
});

test("the manifest: launch intent, Base chains, fork by default, human approval, no clanker-sdk dependency", () => {
  assert.equal(tpl.id, "token-launch-prep");
  assert.equal(tpl.template.framework, "plain-ts");
  assert.deepEqual(tpl.template.intents, ["launch"]);
  assert.deepEqual(tpl.template.chains, ["base", "base-sepolia"]);
  assert.equal(tpl.template.default_network, "fork");
  assert.ok(!tpl.template.networks.includes("mainnet"));
  assert.equal(tpl.template.policy_defaults.human_approval, true);
  assert.equal(tpl.template.policy_defaults.network, "fork");
  assert.ok(!("clanker-sdk" in { ...pkg.dependencies, ...pkg.devDependencies }), "the SDK carries a signing path; this template encodes the call with viem instead");
  for (const c of tpl.capabilities as string[]) assert.match(c, /^(read|prepare|simulate):/, c);
});

test("plain, descriptive wording: no claims the template cannot back", () => {
  const banned = /\b(best|safe|safer|safest|secure|audited|trusted|rug-?free|profit(s|able)?|guaranteed|risk-free|investment opportunity|moon|10x|returns?)\b/i;
  for (const f of ["sato.template.json", "README.md", "package.json"]) {
    const text = readFileSync(f, "utf8")
      // Allowed only in the negations this template states about itself.
      .replace(/not a security review, an audit/g, "")
      .replace(/not audited/gi, "")
      .replace(/never imply returns/gi, "")
      .replace(/deployToken returned|factory returned|the return value/gi, "");
    const m = text.match(banned);
    assert.equal(m, null, `${f}: "${m?.[0]}"`);
  }
});
