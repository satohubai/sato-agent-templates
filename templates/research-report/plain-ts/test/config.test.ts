import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseArgs, UsageError, validateConfig } from "../src/config.js";

const schema = JSON.parse(readFileSync("schemas/input.json", "utf8"));

test("defaults: fixture mode over the chain-read-cited scenario", () => {
  const a = parseArgs([]);
  assert.equal(a.mode, "fixture");
  assert.equal(a.scenario, "chain-read-cited");
  assert.equal(a.config, "config.json");
});

test("fixture mode never takes a model; rpc mode needs an endpoint", () => {
  assert.throws(() => parseArgs(["--model", "anthropic/claude-sonnet-5"]), UsageError);
  assert.throws(() => parseArgs(["--mode", "rpc"]), UsageError);
  assert.equal(parseArgs(["--mode", "rpc"], { SATO_RPC_URL_BASE: "http://127.0.0.1:1" }).rpc, "http://127.0.0.1:1");
  assert.throws(() => parseArgs(["--mode", "mainnet"]), UsageError);
});

test("a chain read of an unknown kind or chain is refused before any read", () => {
  const errs = validateConfig({ question: "q", chain_reads: [{ id: "c", chain: "ethereum", kind: "transfer" }] }, schema);
  assert.ok(errs.some((e) => /chain_reads\[0\]\.chain/.test(e)), errs.join("\n"));
  assert.ok(errs.some((e) => /chain_reads\[0\]\.kind/.test(e)), errs.join("\n"));
});
