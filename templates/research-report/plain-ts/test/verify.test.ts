import { test } from "node:test";
import assert from "node:assert/strict";
import { numbersIn, unsupportedNumbers, verifyProposal } from "../src/verify.js";

test("a hex identifier is not an amount", () => {
  assert.deepEqual(numbersIn("contract 0xdeadbeef1234 holds 42 tokens"), ["42"]);
});

test("a comma is formatting, not part of the number", () => {
  assert.deepEqual(numbersIn("received 1,234,567 units"), ["1234567"]);
  assert.deepEqual(unsupportedNumbers("received 1,234,567 units", [{ content: "total was 1234567" }]), []);
});

test("a number that appears in no cited source is unsupported", () => {
  assert.deepEqual(unsupportedNumbers("it received 9999", [{ content: "it received 4200" }]), ["9999"]);
});

const src = (id: string, content = "") => ({ id, kind: "k", url: "u", retrieved_at: "t", content });

test("a finding citing a source outside the corpus is rejected, not downgraded", () => {
  const out = verifyProposal({ findings: [{ statement: "audited", source_ids: ["nope"], confidence: "high" }] }, [src("s1")]);
  assert.equal(out.findings.length, 0);
  assert.equal(out.rejected[0].reason, "unknown_source");
});

test("a conflict needs at least two sources we actually hold", () => {
  const out = verifyProposal({ conflicts: [{ topic: "t", source_ids: ["s1", "ghost"], detail: "" }] }, [src("s1")]);
  assert.equal(out.conflicts.length, 0);
});

test("uncited and empty findings are rejected with their reasons", () => {
  const out = verifyProposal({ findings: [{ statement: "x", source_ids: [] }, { statement: " ", source_ids: ["s1"] }] }, [src("s1")]);
  assert.deepEqual(out.rejected.map((r) => r.reason), ["uncited", "empty_statement"]);
});
