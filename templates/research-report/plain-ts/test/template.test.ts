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

test("read-only: capabilities are reads or reasoning and the source never prepares, executes or signs", () => {
  for (const c of tpl.capabilities as string[]) assert.match(c, /^(read|reason):/);
  for (const f of readdirSync("src")) {
    const s = readFileSync(`src/${f}`, "utf8");
    assert.doesNotMatch(s, /\.prepare\(|\.execute\(|sendTransaction|signTypedData|privateKey|Signer\(/, f);
  }
});
