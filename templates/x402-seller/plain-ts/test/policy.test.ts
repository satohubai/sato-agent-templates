import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePolicyFile } from "@satohub/kit";
import { loadPolicy } from "../src/policy.js";

test("policy.json is a valid sato.policy/v1 file with a refusing default", () => {
  const p = parsePolicyFile(JSON.parse(readFileSync("policy.json", "utf8")));
  assert.ok(p.ok, p.ok ? "" : p.error);
  const policy = loadPolicy("policy.json");
  assert.equal(policy.network, "fork");
  assert.equal(policy.unknown_verdict, "refuse");
  assert.equal(policy.human_approval, true);
  assert.equal(policy.max_usd_per_trade, 1);
  assert.equal(policy.max_usd_per_day, 1);
});
