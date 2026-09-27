import { test } from "node:test";
import assert from "node:assert/strict";
import { compareBaseUnits, formatUsd, parseUsd, toNative, valueUsd } from "../src/units.js";

test("base units render exactly at 18 decimals", () => {
  assert.equal(toNative("1234567890123456789", 18), "1.234567890123456789");
  assert.equal(toNative("1000000000000000000", 18), "1");
  assert.equal(toNative("1", 18), "0.000000000000000001");
  assert.equal(toNative("0", 18), "0");
});

test("comparison does not go through a float", () => {
  const a = "9007199254740992";
  const b = "9007199254740993";
  assert.equal(compareBaseUnits(a, b), -1);
  assert.equal(Number(a) === Number(b), true, "the float comparison really does collapse them");
});

test("USD arithmetic is exact and truncates", () => {
  assert.equal(formatUsd(parseUsd("1.50")), "1.5");
  assert.equal(formatUsd(valueUsd("250000000", 6, parseUsd("1.00"))), "250");
  assert.equal(formatUsd(valueUsd("1", 6, parseUsd("0.000001"))), "0");
  assert.throws(() => parseUsd("1.0000001"), RangeError);
});
