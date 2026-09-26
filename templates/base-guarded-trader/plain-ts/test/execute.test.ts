// Kit behaviour this template relies on: execute accepts { intent_id } and no
// other key, and never executes in fixture mode (there is no signer).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExecuteRequest } from "@satohub/kit";
import { buildRuntime } from "../src/runtime.js";
import { loadPolicy } from "../src/policy.js";

test("the contract refuses any key besides intent_id", () => {
  assert.equal(parseExecuteRequest({ intent_id: "si_" + "A".repeat(43), extra: 1 }).ok, false);
});

test("kit.execute rejects { intent_id, extra }", async () => {
  const rt = await buildRuntime({ mode: "fixture", policy: loadPolicy("policy.json"), fixturesDir: "fixtures", env: {} });
  const bad = { intent_id: "si_" + "A".repeat(43), extra: "to: 0xattacker" } as unknown as { intent_id: string };
  await assert.rejects(rt.kit.execute(bad), /intent_id|extra|unknown|key/i);
});
