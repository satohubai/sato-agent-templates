import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ConfigError, parseArgs, requireValidConfig, UsageError, validateConfig, type SellerConfig } from "../src/config.js";

const config = JSON.parse(readFileSync("config.json", "utf8")) as SellerConfig;

test("config.json is valid", () => assert.deepEqual(validateConfig(config), []));

test("mainnet is not a mode", () => {
  assert.throws(() => parseArgs(["--mode", "mainnet"]), UsageError);
  assert.equal(parseArgs([]).mode, "fixture");
});

test("testnet refuses the placeholder payee", () => {
  assert.throws(() => requireValidConfig(config, "config.json", "testnet"), ConfigError);
  const own = { ...config, service: { ...config.service, pay_to: "0x1111111111111111111111111111111111111111" } };
  assert.doesNotThrow(() => requireValidConfig(own, "config.json", "testnet"));
});

test("a zero or non-integer price is refused", () => {
  for (const price of ["0", "0.5", "-1", "abc"]) {
    const c = { ...config, routes: [{ ...config.routes[0], price_base_units: price }] };
    assert.ok(validateConfig(c).some((p) => p.includes("price_base_units")), price);
  }
});

test("a fork network that is not Base is refused", () => {
  const c = { ...config, networks: { ...config.networks, fork: { ...config.networks.fork, network: "eip155:1" } } };
  assert.ok(validateConfig(c).length > 0);
});
