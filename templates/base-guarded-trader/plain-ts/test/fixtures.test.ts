import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient } from "viem";
import { base } from "viem/chains";
import { SATO_SWAP_URL } from "@satohub/kit";
import { fixtureFetch, fixtureTransport, httpKey, loadHttpFixtures, loadRpcFixtures, rpcKey } from "../src/fixtures.js";
import { FIXTURE_TAKER } from "../src/runtime.js";
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

test("fixture fetch serves recorded venue quotes by request, for any taker, and refuses anything else", async () => {
  const f = fixtureFetch(loadHttpFixtures("fixtures"));
  const ask = (amount: string, taker: string, mode = "recommend") =>
    f(SATO_SWAP_URL, {
      method: "POST",
      body: JSON.stringify({ chain_in: "base", token_in: TOKENS.base.USDC.address, token_out: TOKENS.base.WETH.address, amount_in: amount, slippage_bps: 50, mode, taker }),
    });
  const small = (await (await ask("10000000", "0x000000000000000000000000000000000000dEaD")).json()) as { disclosure?: string; amount_out?: string };
  const other = (await (await ask("10000000", "0x1111111111111111111111111111111111111111")).json()) as { amount_out?: string };
  const big = (await (await ask("1000000000", "0x000000000000000000000000000000000000dEaD")).json()) as { amount_out?: string };
  assert.equal(typeof small.disclosure, "string");
  assert.equal(small.amount_out, other.amount_out);
  assert.notEqual(small.amount_out, big.amount_out);
  await assert.rejects(ask("12345", "0x000000000000000000000000000000000000dEaD"), /no recorded response/);
  await assert.rejects(f("https://example.com/anything"), /no recorded response/);
});

test("httpKey ignores the taker and nothing else", () => {
  const a = httpKey("GET", "https://li.quest/v1/quote?fromAmount=1&fromAddress=0xA&slippage=0.005", null);
  const b = httpKey("get", "https://li.quest/v1/quote?slippage=0.005&fromAddress=0xB&fromAmount=1", null);
  const c = httpKey("GET", "https://li.quest/v1/quote?fromAmount=2&fromAddress=0xA&slippage=0.005", null);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("every venue fixture was recorded for the fixed taker and names no user-agent or key", () => {
  for (const fx of loadHttpFixtures("fixtures")) {
    const text = JSON.stringify(fx.request);
    assert.doesNotMatch(text, /user-agent|api[_-]?key|authorization/i);
    const u = new URL(fx.request.url);
    const who = (fx.request.body as { taker?: string } | undefined)?.taker ?? u.searchParams.get("fromAddress");
    assert.equal(who?.toLowerCase(), FIXTURE_TAKER.toLowerCase(), fx.request.url);
  }
});
