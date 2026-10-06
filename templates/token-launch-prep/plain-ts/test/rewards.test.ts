// The reward split: the creator, 10000 bps, and nobody else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress } from "viem";
import { CLANKER_V4, unsignedDeployTx, DEFAULT_SALT } from "../src/clanker.js";
import { decodeDeploy, EXAMPLE_CREATOR } from "../src/launch.js";
import { assertSplit, BPS_TOTAL, creatorRewards, RewardSplitError } from "../src/rewards.js";

const CREATOR = getAddress("0x1111111111111111111111111111111111111111");
/** Sato Hub's published fee/treasury address. It must never be a recipient here. */
const SATO_HUB_TREASURY = "0xcEE53Eb001d4d1743EF9df333Dcf45bC38622bE9";

test("the split is the creator alone, as recipient and admin, totalling exactly 10000 bps", () => {
  for (const token of ["Both", "Paired", "Clanker"] as const) {
    const s = creatorRewards(CREATOR, token);
    assert.deepEqual(s, [{ recipient: CREATOR, admin: CREATOR, bps: 10000, token }]);
    assert.equal(s.reduce((a, r) => a + r.bps, 0), BPS_TOTAL);
  }
});

test("a split that does not total 10000, or names anyone but the creator, is refused", () => {
  assert.throws(() => assertSplit([{ recipient: CREATOR, admin: CREATOR, bps: 9500, token: "Both" }], CREATOR), RewardSplitError);
  assert.throws(() => assertSplit([{ recipient: CREATOR, admin: CREATOR, bps: 10001, token: "Both" }], CREATOR), RewardSplitError);
  assert.throws(() => assertSplit([{ recipient: CREATOR, admin: CREATOR, bps: 9999.5, token: "Both" }], CREATOR), RewardSplitError);
  assert.throws(() => assertSplit([], CREATOR), RewardSplitError);
  assert.throws(
    () =>
      assertSplit(
        [
          { recipient: CREATOR, admin: CREATOR, bps: 9500, token: "Both" },
          { recipient: SATO_HUB_TREASURY, admin: SATO_HUB_TREASURY, bps: 500, token: "Both" },
        ],
        CREATOR,
      ),
    /not the creator/,
  );
  assert.throws(() => assertSplit([{ recipient: CREATOR, admin: SATO_HUB_TREASURY, bps: 10000, token: "Both" }], CREATOR), /not the creator/);
  assert.throws(() => creatorRewards("0x0000000000000000000000000000000000000000"), RewardSplitError);
});

test("the encoded calldata carries the creator's 10000 bps and no other recipient, on both chains", () => {
  for (const chain of ["base", "base-sepolia"] as const) {
    const { tx } = unsignedDeployTx({
      chain, name: "T", symbol: "T", image: "", description: null, interface_name: "x", token_admin: CREATOR, salt: DEFAULT_SALT,
      pool_preset: "standard", clanker_fee_bps: 100, paired_fee_bps: 100, rewards: creatorRewards(CREATOR),
    });
    const cfg = decodeDeploy(tx.data);
    assert.deepEqual(cfg.lockerConfig.rewardRecipients, [CREATOR]);
    assert.deepEqual(cfg.lockerConfig.rewardAdmins, [CREATOR]);
    assert.deepEqual(cfg.lockerConfig.rewardBps, [10000]);
    assert.equal(cfg.tokenConfig.tokenAdmin, CREATOR);
    assert.ok(!tx.data.toLowerCase().includes(SATO_HUB_TREASURY.slice(2).toLowerCase()), `${chain}: the Sato Hub address is in the calldata`);
    assert.equal(tx.to, CLANKER_V4[chain].factory);
  }
});

test("no Sato Hub address anywhere in the template's source, config or fixtures", () => {
  const files = ["config.json", "policy.json", "sato.template.json", ...readdirSync("src").map((f) => join("src", f)), ...readdirSync("fixtures/scenarios").map((f) => join("fixtures/scenarios", f)), "fixtures/rpc.json"];
  for (const f of files) assert.ok(!readFileSync(f, "utf8").toLowerCase().includes(SATO_HUB_TREASURY.slice(2).toLowerCase()), f);
  assert.ok(!readFileSync("src/launch.ts", "utf8").includes("satohub.ai/api/route"), "the template never calls Sato Hub's launch route");
});

test("every address written in src/ is a Clanker contract, WETH, or the example creator", () => {
  const known = new Set<string>([EXAMPLE_CREATOR.toLowerCase()]);
  for (const c of Object.values(CLANKER_V4)) for (const v of Object.values(c)) if (typeof v === "string" && v.startsWith("0x")) known.add(v.toLowerCase());
  for (const f of readdirSync("src")) {
    for (const m of readFileSync(join("src", f), "utf8").matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)) assert.ok(known.has(m[0].toLowerCase()), `${f}: ${m[0]}`);
  }
});
