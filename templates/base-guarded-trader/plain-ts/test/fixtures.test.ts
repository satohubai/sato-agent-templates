import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient } from "viem";
import { base } from "viem/chains";
import { fixtureFetch, fixtureTransport, loadHttpFixtures, loadRpcFixtures, rpcKey } from "../src/fixtures.js";
import { ERC20_ABI, ETH_USD_FEED, FEED_ABI, TOKENS } from "../src/tokens.js";
import { EXPECTED, PINNED_BLOCK } from "../scripts/fork-expected.js";

const client = createPublicClient({ chain: base, transport: fixtureTransport(loadRpcFixtures("fixtures")) });

test("rpcKey ignores the block tag on contract reads", () => {
  const a = rpcKey("eth_call", [{ to: "0xAB", data: "0x01" }, "latest"]);
  const b = rpcKey("eth_call", [{ to: "0xab", data: "0x01" }, "0x31667c0"]);
  assert.equal(a, b);
});

test("recorded RPC answers reproduce the pinned-block values", async () => {
  assert.equal(await client.getChainId(), 8453);
  assert.equal(await client.getBlockNumber(), PINNED_BLOCK);
  const round = await client.readContract({ address: ETH_USD_FEED.base, abi: FEED_ABI, functionName: "latestRoundData" });
  assert.equal(round[1], EXPECTED.eth_usd_feed.answer);
  assert.equal(await client.readContract({ address: ETH_USD_FEED.base, abi: FEED_ABI, functionName: "description" }), "ETH / USD");
  assert.equal(await client.readContract({ address: TOKENS.base.USDC.address, abi: ERC20_ABI, functionName: "totalSupply" }), EXPECTED.usdc.total_supply);
});

test("an unrecorded RPC call throws instead of reaching the network", async () => {
  await assert.rejects(client.getBalance({ address: "0x000000000000000000000000000000000000dEaD" }), /no recorded RPC answer/);
});

test("fixture fetch serves recorded venue quotes by amount and refuses anything else", async () => {
  const f = fixtureFetch(loadHttpFixtures("fixtures"));
  const u = (amt: string) => `https://satohub.ai/api/route/swap?chain=base&token_in=${TOKENS.base.USDC.address}&token_out=${TOKENS.base.WETH.address}&amount=${amt}`;
  const small = (await (await f(u("10000000"))).json()) as { disclosure?: string; quote?: { amount_in?: string } };
  const big = (await (await f(u("1000000000"))).json()) as { quote?: { amount_in?: string } };
  assert.equal(typeof small.disclosure, "string");
  assert.notDeepEqual(small, big);
  await assert.rejects(f("https://example.com/anything"), /no recorded response/);
});
