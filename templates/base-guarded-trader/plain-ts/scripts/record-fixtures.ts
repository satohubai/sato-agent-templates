// Refresh fixtures/ from a local anvil fork of Base at the pinned block.
//
//   anvil --fork-url https://mainnet.base.org --fork-block-number 51800000 --port 8547
//   ANVIL_RPC_URL=http://127.0.0.1:8547 npx tsx scripts/record-fixtures.ts [--http]
//
// RPC: the market reads the agent makes, answered by the fork, keyed on
// (method, to, calldata). For everything the kit itself asks the chain, run
// `npm start -- --mode fork --record`, which records through the same key.
// --http also records the venue quotes (Sato Swap and a direct KyberSwap
// quote) for the two sizes the mock model proposes. Those are live calls.

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient } from "viem";
import { base } from "viem/chains";
import { recordingTransport, writeRpcFixtures, type RpcFixtures } from "../src/fixtures.js";
import { ERC20_ABI, ETH_USD_FEED, FEED_ABI, TOKENS } from "../src/tokens.js";
import { PINNED_BLOCK } from "./fork-expected.js";

const RECORD_UA = "SatoHub-templates-record/1.0";

async function main() {
  const url = process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:8547";
  const sink: RpcFixtures = {};
  const client = createPublicClient({ chain: base, transport: recordingTransport(url, sink) });
  const block = await client.getBlockNumber();
  if (block !== PINNED_BLOCK) throw new Error(`the fork is at block ${block}, expected the pinned ${PINNED_BLOCK}; restart anvil with --fork-block-number ${PINNED_BLOCK}`);
  await client.getChainId();
  await client.getGasPrice();
  const feed = ETH_USD_FEED.base;
  for (const functionName of ["decimals", "description", "latestRoundData"] as const) await client.readContract({ address: feed, abi: FEED_ABI, functionName });
  await client.readContract({ address: TOKENS.base.USDC.address, abi: ERC20_ABI, functionName: "totalSupply" });
  writeRpcFixtures("fixtures", sink, { recorded_from: `anvil fork of Base at block ${PINNED_BLOCK}`, pinned_block: PINNED_BLOCK.toString() });
  console.log(`recorded ${Object.keys(sink).length} RPC answers`);

  if (process.argv.includes("--http")) {
    mkdirSync(join("fixtures", "http"), { recursive: true });
    const usdc = TOKENS.base.USDC.address;
    const weth = TOKENS.base.WETH.address;
    for (const amount of ["10000000", "1000000000"]) {
      const targets = [
        [`sato-route-swap-${amount}.json`, `https://satohub.ai/api/route/swap?chain=base&token_in=${usdc}&token_out=${weth}&amount=${amount}`],
        [`kyberswap-routes-${amount}.json`, `https://aggregator-api.kyberswap.com/base/api/v1/routes?tokenIn=${usdc}&tokenOut=${weth}&amountIn=${amount}`],
      ] as const;
      for (const [file, u] of targets) {
        const res = await fetch(u, { headers: { "user-agent": RECORD_UA }, signal: AbortSignal.timeout(20_000) });
        const body = await res.json();
        writeFileSync(
          join("fixtures", "http", file),
          JSON.stringify({ request: { method: "GET", url: u }, response: { status: res.status, body }, recorded_at: new Date().toISOString() }, null, 2) + "\n",
        );
        console.log(`recorded ${file} (${res.status})`);
      }
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
