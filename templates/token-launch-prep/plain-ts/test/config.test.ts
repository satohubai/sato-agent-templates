import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ConfigError, parseArgs, parseLaunchInput, UsageError, validateConfig } from "../src/config.js";

const schema = JSON.parse(readFileSync("schemas/input.json", "utf8"));
const OK = { name: "Example Token", symbol: "EXMPL", creator: "0x1111111111111111111111111111111111111111" };

test("defaults: fixture mode, config.json, policy.json, out/", () => {
  assert.deepEqual(parseArgs([]), { mode: "fixture", config: "config.json", policy: "policy.json", out: "out", record: false });
});

test("modes: no mainnet mode, rpc needs an endpoint, --record only with fork", () => {
  assert.throws(() => parseArgs(["--mode", "mainnet"]), UsageError);
  assert.throws(() => parseArgs(["--mode", "rpc"]), UsageError);
  assert.equal(parseArgs(["--mode", "rpc"], { SATO_RPC_URL_BASE: "http://127.0.0.1:1" }).rpc, "http://127.0.0.1:1");
  assert.throws(() => parseArgs(["--rpc", "http://x"]), UsageError);
  assert.throws(() => parseArgs(["--record"]), UsageError);
  assert.throws(() => parseArgs(["--broadcast"]), UsageError);
});

test("defaults are applied after validation, mirroring clanker-sdk", () => {
  const i = parseLaunchInput(OK, schema);
  assert.equal(i.chain, "base");
  assert.equal(i.sender, i.creator);
  assert.equal(i.image, "");
  assert.equal(i.description, null);
  assert.equal(i.interface_name, "token-launch-prep");
  assert.equal(i.salt, `0x${"0".repeat(64)}`);
  assert.equal(i.pool_preset, "standard");
  assert.equal(i.clanker_fee_bps, 100);
  assert.equal(i.paired_fee_bps, 100);
  assert.equal(i.reward_token, "Both");
});

test("required fields and shapes are enforced", () => {
  const bad: [unknown, RegExp][] = [
    [{ symbol: "X", creator: OK.creator }, /name is required/],
    [{ ...OK, name: "" }, /name is shorter/],
    [{ ...OK, name: " padded" }, /name does not match/],
    [{ ...OK, name: "a\u0007b" }, /name does not match/],
    [{ ...OK, name: "x".repeat(65) }, /name is longer/],
    [{ ...OK, symbol: "TOO-LONG-SYMBOL-XX" }, /symbol is longer/],
    [{ ...OK, symbol: "HAS SPACE" }, /symbol does not match/],
    [{ ...OK, creator: "0x123" }, /creator does not match/],
    [{ ...OK, image: "http://example.com/a.png" }, /image does not match/],
    [{ ...OK, image: "javascript:alert(1)" }, /image does not match/],
    [{ ...OK, chain: "ethereum" }, /chain must be one of/],
    [{ ...OK, pool_preset: "moon" }, /pool_preset must be one of/],
    [{ ...OK, fees: { clanker_fee_bps: 2001 } }, /clanker_fee_bps must be at most 2000/],
    [{ ...OK, fees: { paired_fee_bps: 1.5 } }, /paired_fee_bps must be integer/],
    [{ ...OK, salt: "0x01" }, /salt does not match/],
    [{ ...OK, reward_token: "ETH" }, /reward_token must be one of/],
    [{ ...OK, recipients: [] }, /recipients is not a property/],
    [{ ...OK, simbol: "X" }, /did you mean symbol/],
  ];
  for (const [input, re] of bad) {
    assert.throws(() => parseLaunchInput(input, schema), (e: unknown) => e instanceof ConfigError && re.test(e.message), JSON.stringify(input));
  }
  assert.deepEqual(validateConfig(JSON.parse(readFileSync("config.json", "utf8")), schema), []);
});

test("addresses: zero and bad checksums are refused, lower case is accepted", () => {
  assert.throws(() => parseLaunchInput({ ...OK, creator: "0x0000000000000000000000000000000000000000" }, schema), /zero address/);
  assert.throws(() => parseLaunchInput({ ...OK, creator: "0xAbCdEf0000000000000000000000000000000000" }, schema), /checksum/);
  const i = parseLaunchInput({ ...OK, creator: "0x000000000000000000000000000000000000dead" }, schema);
  assert.equal(i.creator, "0x000000000000000000000000000000000000dEaD");
});

test("no key in any form: a key-like property is refused by name, anywhere in the input", () => {
  for (const k of ["private_key", "privateKey", "mnemonic", "seed_phrase", "secret", "signer", "api_key", "keystore"]) {
    assert.throws(() => parseLaunchInput({ ...OK, [k]: "x" }, schema), (e: unknown) => e instanceof ConfigError && /takes no private key/.test(e.message), k);
  }
  assert.throws(() => parseLaunchInput({ ...OK, fees: { private_key: "x" } }, schema), /takes no private key/);
  assert.ok(!Object.keys(schema.properties).some((k) => /key|secret|mnemonic|seed|signer/i.test(k)), "the input schema has no key-like property");
});
