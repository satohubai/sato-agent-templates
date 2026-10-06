// The deployToken encoding, against values copied from clanker-sdk 4.2.19.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeAbiParameters, getAddress, toFunctionSelector } from "viem";
import { CLANKER_V4, DEFAULT_SALT, POOL_PRESETS, SNIPER_FEES, unsignedDeployTx, type DeployParams } from "../src/clanker.js";
import { decodeDeploy, summarize } from "../src/launch.js";
import { creatorRewards } from "../src/rewards.js";

const CREATOR = getAddress("0x1111111111111111111111111111111111111111");
const P: DeployParams = {
  chain: "base", name: "Example Token", symbol: "EXMPL", image: "", description: "d", interface_name: "token-launch-prep",
  token_admin: CREATOR, salt: DEFAULT_SALT, pool_preset: "standard", clanker_fee_bps: 100, paired_fee_bps: 100, rewards: creatorRewards(CREATOR),
};

test("the addresses are clanker-sdk 4.2.19's clanker_v4 and clanker_v4_sepolia entries", () => {
  assert.deepEqual(
    { factory: CLANKER_V4.base.factory, locker: CLANKER_V4.base.locker, hook: CLANKER_V4.base.static_fee_hook, mev: CLANKER_V4.base.mev_module, feeLocker: CLANKER_V4.base.fee_locker },
    { factory: "0xE85A59c628F7d27878ACeB4bf3b35733630083a9", locker: "0xffA37784D619F228D8B379d287a4D7282e500762", hook: "0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC", mev: "0xebB25BB797D82CB78E1bc70406b13233c0854413", feeLocker: "0xF3622742b1E446D92e45E22923Ef11C2fcD55D68" },
  );
  assert.deepEqual(
    { factory: CLANKER_V4["base-sepolia"].factory, locker: CLANKER_V4["base-sepolia"].locker, hook: CLANKER_V4["base-sepolia"].static_fee_hook, mev: CLANKER_V4["base-sepolia"].mev_module },
    { factory: "0xE85A59c628F7d27878ACeB4bf3b35733630083a9", locker: "0x824bB048a5EC6e06a09aEd115E9eEA4618DC2c8f", hook: "0x11b51DBC2f7F683b81CeDa83DC0078D57bA328cc", mev: "0x261fE99C4D0D41EE8d0e594D11aec740E8354ab0" },
  );
  for (const c of Object.values(CLANKER_V4)) for (const v of Object.values(c)) if (typeof v === "string" && v.startsWith("0x")) assert.equal(v, getAddress(v), "checksummed");
});

test("the calldata is deployToken with value 0 and decodes back to what was asked", () => {
  const { tx, config } = unsignedDeployTx(P);
  assert.equal(tx.data.slice(0, 10), toFunctionSelector("deployToken(((address,string,string,bytes32,string,string,string,uint256),(address,address,int24,int24,bytes),(address,address[],address[],uint16[],int24[],int24[],uint16[],bytes),(address,bytes),(address,uint256,uint16,bytes)[]))"));
  assert.equal(tx.value, "0");
  assert.equal(tx.chain_id, 8453);
  const d = decodeDeploy(tx.data);
  assert.deepEqual(d, config);
  assert.equal(d.tokenConfig.metadata, JSON.stringify({ description: "d" }));
  assert.equal(d.tokenConfig.context, JSON.stringify({ interface: "token-launch-prep" }));
  assert.equal(d.tokenConfig.originatingChainId, 8453n);
  assert.equal(d.poolConfig.pairedToken, CLANKER_V4.base.weth);
  assert.equal(d.poolConfig.tickIfToken0IsClanker, -230400);
  assert.equal(d.poolConfig.tickSpacing, 200);
  assert.deepEqual(d.extensionConfigs, []);
  // v4.1 pool data: (extension, extensionData, feeData) with feeData = (uint24 1% , uint24 1%) in uniBps.
  const [pool] = decodeAbiParameters([{ type: "tuple", components: [{ name: "extension", type: "address" }, { name: "extensionData", type: "bytes" }, { name: "feeData", type: "bytes" }] }], d.poolConfig.poolData);
  assert.equal(pool.extension, "0x0000000000000000000000000000000000000000");
  assert.deepEqual(decodeAbiParameters([{ type: "uint24" }, { type: "uint24" }], pool.feeData), [10000, 10000]);
  const [mev] = decodeAbiParameters([{ type: "tuple", components: [{ name: "startingFee", type: "uint24" }, { name: "endingFee", type: "uint24" }, { name: "secondsToDecay", type: "uint256" }] }], d.mevModuleConfig.mevModuleData);
  assert.deepEqual(mev, { startingFee: SNIPER_FEES.startingFee, endingFee: SNIPER_FEES.endingFee, secondsToDecay: 15n });
});

test("pool presets: positions sum to 10000 bps, sit on the tick spacing, and one touches the start tick", () => {
  for (const [name, ps] of Object.entries(POOL_PRESETS)) {
    assert.equal(ps.reduce((a, p) => a + p.positionBps, 0), 10000, name);
    assert.ok(ps.every((p) => p.tickLower % 200 === 0 && p.tickUpper % 200 === 0 && p.tickLower < p.tickUpper), name);
    assert.ok(ps.some((p) => p.tickLower === -230400), name);
  }
});

test("Base Sepolia: same factory, its own locker and hook, and no sniper init data (as clanker-sdk builds it)", () => {
  const { tx } = unsignedDeployTx({ ...P, chain: "base-sepolia" });
  const d = decodeDeploy(tx.data);
  assert.equal(tx.chain_id, 84532);
  assert.equal(d.tokenConfig.originatingChainId, 84532n);
  assert.equal(d.mevModuleConfig.mevModuleData, "0x");
  assert.equal(d.lockerConfig.locker, CLANKER_V4["base-sepolia"].locker);
});

test("the summary is read from the calldata and states what is and is not in it", () => {
  const { tx } = unsignedDeployTx(P);
  const s = summarize(
    { chain: "base", name: P.name, symbol: P.symbol, creator: CREATOR, sender: CREATOR, image: "", description: "d", interface_name: "token-launch-prep", salt: DEFAULT_SALT, pool_preset: "standard", clanker_fee_bps: 100, paired_fee_bps: 100, reward_token: "Both" },
    tx,
  );
  assert.equal(s.rewards.total_bps, 10000);
  assert.equal(s.value_wei, "0");
  assert.match(s.lines.join("\n"), /sending 0 ETH/);
  assert.match(s.lines.join("\n"), /No other recipient is written/);
  assert.match(s.lines.join("\n"), /No dev buy, vault, airdrop or presale extension/);
});
