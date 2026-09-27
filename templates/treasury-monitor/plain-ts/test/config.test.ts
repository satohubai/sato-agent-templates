import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { ConfigError, loadCheckpoint, parseArgs, requireValidConfig, UsageError, validateConfig } from "../src/config.js";

const schema = JSON.parse(readFileSync("schemas/input.json", "utf8"));

test("defaults: fixture mode, config.json, policy.json, out/", () => {
  assert.deepEqual(parseArgs([]), { mode: "fixture", config: "config.json", policy: "policy.json", out: "out", record: false });
});

test("rpc mode needs an endpoint and takes SATO_RPC_URL_BASE", () => {
  assert.throws(() => parseArgs(["--mode", "rpc"]), UsageError);
  assert.equal(parseArgs(["--mode", "rpc"], { SATO_RPC_URL_BASE: "http://127.0.0.1:1" }).rpc, "http://127.0.0.1:1");
  assert.throws(() => parseArgs(["--rpc", "http://x"]), UsageError);
  assert.throws(() => parseArgs(["--mode", "mainnet"]), UsageError);
  assert.throws(() => parseArgs(["--record"]), UsageError);
});

test("a typo is named with its near-miss", () => {
  const errs = validateConfig({ assets: [], adresses: [] }, schema);
  assert.ok(errs.some((e) => /adresses.*did you mean addresses/.test(e)), errs.join("\n"));
  assert.throws(() => requireValidConfig({}, schema), ConfigError);
});

test("checkpoint: missing is a cold start, unreadable is an error", () => {
  const d = mkdtempSync(join(tmpdir(), "tm-"));
  assert.equal(loadCheckpoint(join(d, "none.json")), null);
  writeFileSync(join(d, "bad.json"), "{");
  assert.throws(() => loadCheckpoint(join(d, "bad.json")), /refusing to start cold/);
});
