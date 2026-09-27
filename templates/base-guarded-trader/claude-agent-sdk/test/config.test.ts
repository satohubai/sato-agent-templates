import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseArgs, parseConfig, UsageError } from "../src/config.js";

test("fixture is the default mode", () => {
  assert.equal(parseArgs([]).mode, "fixture");
  assert.equal(parseArgs(["--mode", "fork"]).mode, "fork");
});

test("mainnet is not offered", () => {
  assert.throws(() => parseArgs(["--mode", "mainnet"]), /mainnet is not offered/);
});

test("--execute is accepted only on testnet", () => {
  assert.throws(() => parseArgs(["--execute"]), UsageError);
  assert.throws(() => parseArgs(["--mode", "fork", "--execute"]), UsageError);
  assert.equal(parseArgs(["--mode", "testnet", "--execute"]).execute, true);
});

test("unknown arguments are refused", () => {
  assert.throws(() => parseArgs(["--yolo"]), UsageError);
  assert.throws(() => parseArgs(["--mode"]), UsageError);
});

test("the shipped config.json parses and uses the Sato Swap default", () => {
  const cfg = parseConfig(JSON.parse(readFileSync("config.json", "utf8")));
  assert.equal(cfg.venue, "sato");
});

test("venue direct opts out of Sato", () => {
  assert.equal(parseConfig({ venue: "direct" }).venue, "direct");
  assert.throws(() => parseConfig({ venue: "uniswap" }), UsageError);
});

test("amounts are positive decimal strings", () => {
  assert.throws(() => parseConfig({ amount_usdc: 10 }), UsageError);
  assert.throws(() => parseConfig({ amount_usdc: "-1" }), UsageError);
  assert.throws(() => parseConfig({ amount_usdc: "1.1234567" }), UsageError);
  assert.throws(() => parseConfig({ surprise: true }), UsageError);
});

test("the scripted model is the default; --model-id only with --model claude", () => {
  assert.equal(parseArgs([]).model, "scripted");
  assert.equal(parseArgs(["--model", "claude"]).model_id, "claude-opus-5-5");
  assert.equal(parseArgs(["--model", "claude", "--model-id", "x"]).model_id, "x");
  assert.throws(() => parseArgs(["--model-id", "x"]), UsageError);
  assert.throws(() => parseArgs(["--model", "gpt"]), UsageError);
  assert.throws(() => parseArgs(["--mode", "fork", "--record", "--model", "claude"]), UsageError);
});
