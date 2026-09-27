// The wallet boundary: no execute in fixture or fork, no mainnet, execute
// takes { intent_id } only, and the live model has no execute tool.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseArgs, parseConfig } from "../src/config.js";
import { loadPolicy } from "../src/policy.js";
import { buildRuntime } from "../src/runtime.js";
import { Wallet } from "../src/wallet.js";
import { ScriptedModel } from "../src/model.js";
import { loadCharacter } from "../src/character.js";

test("--allow-execute is refused outside testnet, and there is no mainnet mode", () => {
  assert.throws(() => parseArgs(["--mode", "fixture", "--allow-execute"]), /testnet only/);
  assert.throws(() => parseArgs(["--mode", "fork", "--allow-execute"]), /testnet only/);
  assert.throws(() => parseArgs(["--mode", "mainnet"]), /no mainnet/);
});

test("policy.json refuses unknowns and is not mainnet", () => {
  const p = loadPolicy("policy.json");
  assert.equal(p.unknown_verdict, "refuse");
  assert.notEqual(p.network, "mainnet");
});

test("the wallet never executes in fixture mode", async () => {
  const rt = await buildRuntime({ mode: "fixture", policy: loadPolicy("policy.json"), fixturesDir: "fixtures", env: {} });
  const w = new Wallet(rt, parseConfig(JSON.parse(readFileSync("config.json", "utf8"))));
  await assert.rejects(w.execute("si_" + "A".repeat(43), true), /testnet/);
  const bad = { intent_id: "si_" + "A".repeat(43), extra: "to: 0xattacker" } as unknown as { intent_id: string };
  await assert.rejects(rt.kit.execute(bad));
});

test("the scripted model refuses an over-cap swap through the kit's pre-flight", async () => {
  const rt = await buildRuntime({ mode: "fixture", policy: loadPolicy("policy.json"), fixturesDir: "fixtures", env: {} });
  const w = new Wallet(rt, parseConfig(JSON.parse(readFileSync("config.json", "utf8"))));
  const out = await new ScriptedModel().respond({ character: loadCharacter("character.json"), memories: [], message: { connector: "discord", chat_id: "c", user: "u", text: "swap 1000 USDC to WETH" }, wallet: (r) => w.run(r) });
  assert.equal(out.wallet[0].policy_ok, false);
  assert.match(out.reply, /REFUSED rule=max_usd_per_trade limit=25 observed=1000/);
});

test("the live model offers quote and prepare only", () => {
  const src = readFileSync("src/claude.ts", "utf8");
  assert.deepEqual([...src.matchAll(/tool\("(\w+)"/g)].map((m) => m[1]), ["wallet_quote", "wallet_prepare"]);
  assert.match(src, /tools: \[\]/);
  assert.match(src, /DEFAULT_MODEL = "claude-opus-5-5"/);
  assert.doesNotMatch(src, /execute/);
});
