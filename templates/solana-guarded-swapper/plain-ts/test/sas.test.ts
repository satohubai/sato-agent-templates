// The receipt reader against account bytes made by the official SAS encoders
// (@solana/attestation 2.1.0, used once to produce test/fixtures/sas-golden.json).
// The reader here is independent code; these tests are what keep it honest.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { receiptAddress, receiptNonce, readReceiptsFromChain, SAS_PROGRAM_ID, decodeSchemaAccount, digestToHex, type Deployment } from "../src/preflight/sas.js";
import type { JsonRpc } from "../src/preflight/types.js";

const golden = JSON.parse(readFileSync("test/fixtures/sas-golden.json", "utf8")) as {
  credential: string;
  schema: string;
  subject_id: string;
  version: string;
  vec_u8: { schema_b64: string; attestation_b64: string; digest_hex: string };
  string_hex: { schema_b64: string; attestation_b64: string; digest_hex: string };
};
const deployment: Deployment = { cluster: "devnet", credential: golden.credential, schema: golden.schema };

// Computed once with the official findAttestationPda from @solana/attestation 2.1.0.
const OFFICIAL = {
  "npm:@satohub/kit@0.1.1": { nonce: "5aaxnUvsyAcY4KdDAxscLsXtyU9cYQHzXhPEzqV2daGh", pda: "2SMthxVKTzNYNTNjrsKXXbjtd2demyhMaRWyaQjyEUoR" },
  "npm:viem@2.57.2": { nonce: "7D3GYUwpnFqfR6obaoBho6u5HcG6Q9MjLn7bLqjjnLgS", pda: "Eo8njSsFmNcjXCrBHx7PhhNT9BLcNAuvBpVvBSZ6baMM" },
};

test("the SAS program id is the one the plan names", () => {
  assert.equal(SAS_PROGRAM_ID, "22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG");
});

test("nonce and address match the official SAS client's derivation", async () => {
  for (const [key, want] of Object.entries(OFFICIAL)) {
    const at = key.lastIndexOf("@");
    const id = key.slice(0, at);
    const v = key.slice(at + 1);
    assert.equal(receiptNonce(id, v), want.nonce, `nonce ${key}`);
    assert.equal(await receiptAddress(id, v, deployment), want.pda, `address ${key}`);
  }
});

type Acct = { data: [string, string]; owner: string } | null;
const acct = (b64: string, owner = SAS_PROGRAM_ID): Acct => ({ data: [b64, "base64"], owner });

/** An RPC that answers getMultipleAccounts from a map of address -> account, and counts calls. */
function mockRpc(accounts: Record<string, Acct>, calls: { n: number } = { n: 0 }): JsonRpc {
  return async (method, params) => {
    assert.equal(method, "getMultipleAccounts", "only a read method is ever sent");
    calls.n++;
    const [addrs] = params as [string[]];
    return { context: { slot: 1 }, value: addrs.map((a) => accounts[a] ?? null) };
  };
}

const ADDR = "2SMthxVKTzNYNTNjrsKXXbjtd2demyhMaRWyaQjyEUoR";

test("decodes a receipt whose digest is stored as 32 raw bytes (VecU8)", async () => {
  const g = golden.vec_u8;
  const out = await readReceiptsFromChain(mockRpc({ [golden.schema]: acct(g.schema_b64), [ADDR]: acct(g.attestation_b64) }), deployment, [{ subject_id: golden.subject_id, version: golden.version }]);
  const r = out.get("npm:@satohub/kit@0.1.1");
  assert.ok(r?.ok && r.receipt);
  const rc = r.receipt!;
  assert.equal(rc.digest_hex, g.digest_hex);
  assert.equal(rc.key_access, "none_found");
  assert.equal(rc.key_egress, "not_observed");
  assert.equal(rc.fund_action_count, null, "-1 is unknown, not zero");
  assert.equal(rc.as_of, "2026-10-05");
  assert.equal(rc.method_version, "custody-2");
  assert.equal(rc.attestation_address, ADDR);
  assert.equal(rc.cluster, "devnet");
  assert.equal(rc.explorer_url, `https://explorer.solana.com/address/${ADDR}?cluster=devnet`);
});

test("decodes a receipt whose digest is stored as hex text (String)", async () => {
  const g = golden.string_hex;
  const out = await readReceiptsFromChain(mockRpc({ [golden.schema]: acct(g.schema_b64), [ADDR]: acct(g.attestation_b64) }), deployment, [{ subject_id: golden.subject_id, version: golden.version }]);
  const r = out.get("npm:@satohub/kit@0.1.1");
  assert.ok(r?.ok && r.receipt);
  assert.equal(r.receipt!.digest_hex, g.digest_hex);
});

test("no attestation at the address is no reading, not an error", async () => {
  const out = await readReceiptsFromChain(mockRpc({ [golden.schema]: acct(golden.vec_u8.schema_b64) }), deployment, [{ subject_id: golden.subject_id, version: golden.version }]);
  assert.deepEqual(out.get("npm:@satohub/kit@0.1.1"), { ok: true, receipt: null });
});

test("the schema account is read once per call, along with all the attestations", async () => {
  const calls = { n: 0 };
  const keys = Array.from({ length: 150 }, (_, i) => ({ subject_id: `npm:pkg-${i}`, version: "1.0.0" }));
  const out = await readReceiptsFromChain(mockRpc({ [golden.schema]: acct(golden.vec_u8.schema_b64) }, calls), deployment, keys);
  assert.equal(out.size, 150);
  assert.equal(calls.n, 2, "150 subjects + the schema fit in two getMultipleAccounts calls of at most 100");
});

test("an account owned by another program is refused", async () => {
  const out = await readReceiptsFromChain(
    mockRpc({ [golden.schema]: acct(golden.vec_u8.schema_b64), [ADDR]: acct(golden.vec_u8.attestation_b64, "11111111111111111111111111111111") }),
    deployment,
    [{ subject_id: golden.subject_id, version: golden.version }],
  );
  const r = out.get("npm:@satohub/kit@0.1.1");
  assert.equal(r?.ok, false);
  assert.match((r as { error: string }).error, /not owned by the SAS program/);
});

test("an attestation from a different credential is refused", async () => {
  const other: Deployment = { ...deployment, credential: "5aaxnUvsyAcY4KdDAxscLsXtyU9cYQHzXhPEzqV2daGh" };
  const addr = await receiptAddress(golden.subject_id, golden.version, other);
  const out = await readReceiptsFromChain(mockRpc({ [golden.schema]: acct(golden.vec_u8.schema_b64), [addr]: acct(golden.vec_u8.attestation_b64) }), other, [{ subject_id: golden.subject_id, version: golden.version }]);
  const r = out.get("npm:@satohub/kit@0.1.1");
  assert.equal(r?.ok, false);
});

test("a missing schema account makes every subject an error, never a quiet no-reading", async () => {
  const out = await readReceiptsFromChain(mockRpc({}), deployment, [{ subject_id: golden.subject_id, version: golden.version }]);
  const r = out.get("npm:@satohub/kit@0.1.1");
  assert.equal(r?.ok, false);
  assert.match((r as { error: string }).error, /schema account .* does not exist/);
});

test("an expired attestation is no reading; expiry 0 never expires", async () => {
  const key = [{ subject_id: golden.subject_id, version: golden.version }];
  const never = await readReceiptsFromChain(mockRpc({ [golden.schema]: acct(golden.vec_u8.schema_b64), [ADDR]: acct(golden.vec_u8.attestation_b64) }), deployment, key, () => 4_000_000_000_000);
  const r0 = never.get("npm:@satohub/kit@0.1.1");
  assert.ok(r0?.ok && r0.receipt, "expiry 0 means never expires");

  // Patch the i64 expiry in the golden bytes: discriminator 1 + three addresses 96 + u32 length + data, then signer 32, then expiry.
  const bytes = Buffer.from(golden.vec_u8.attestation_b64, "base64");
  const dataLen = bytes.readUInt32LE(97);
  bytes.writeBigInt64LE(1_700_000_000n, 97 + 4 + dataLen + 32);
  const expired = await readReceiptsFromChain(mockRpc({ [golden.schema]: acct(golden.vec_u8.schema_b64), [ADDR]: acct(bytes.toString("base64")) }), deployment, key, () => 1_800_000_000_000);
  assert.deepEqual(expired.get("npm:@satohub/kit@0.1.1"), { ok: true, receipt: null, note: "the attestation has expired" });
  const live = await readReceiptsFromChain(mockRpc({ [golden.schema]: acct(golden.vec_u8.schema_b64), [ADDR]: acct(bytes.toString("base64")) }), deployment, key, () => 1_600_000_000_000);
  const r1 = live.get("npm:@satohub/kit@0.1.1");
  assert.ok(r1?.ok && r1.receipt, "before its expiry it is a reading");
});

test("the schema decoder reads field names and types from the account", () => {
  const s = decodeSchemaAccount(new Uint8Array(Buffer.from(golden.vec_u8.schema_b64, "base64")));
  assert.equal(s.name, "sato-build-receipt");
  assert.deepEqual(s.fieldNames, ["subject_kind", "subject_id", "version", "digest", "key_access", "key_egress", "fund_action_count", "method_version", "as_of", "reading_url"]);
  assert.equal(s.layout[3], "VecU8");
  assert.equal(s.layout[6], "I32");
});

test("digestToHex accepts 32 bytes or 64 hex characters and nothing else", () => {
  assert.equal(digestToHex(Array(32).fill(255)), "ff".repeat(32));
  assert.equal(digestToHex("0x" + "AB".repeat(32)), "ab".repeat(32));
  assert.throws(() => digestToHex(Array(31).fill(1)));
  assert.throws(() => digestToHex("abc"));
});
