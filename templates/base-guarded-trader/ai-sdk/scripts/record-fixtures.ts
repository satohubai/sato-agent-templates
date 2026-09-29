// Refresh fixtures/ from a local anvil fork of Base at the pinned block.
//
//   anvil --fork-url https://mainnet.base.org --fork-block-number 51800000 --port 8547
//   ANVIL_RPC_URL=http://127.0.0.1:8547 npx tsx scripts/record-fixtures.ts
//   ANVIL_RPC_URL=http://127.0.0.1:8547 npm start -- --mode fork --record
//
// This script records the pinned-block reads the tests assert on, answered by
// the fork and keyed on (method, to, calldata). The second command records
// everything the agent run asks: every RPC call the kit makes (chain.read,
// allowance reads, the eth_call + eth_estimateGas simulation) and every venue
// request (Sato Swap in recommend and build-tx mode, and the LI.FI quote with
// no Sato fee) for the two sizes the mock model proposes. The venue calls are
// live and send the user-agent sato-template/base-guarded-trader@0.1.0.

import { createPublicClient } from "viem";
import { base } from "viem/chains";
import { recordingTransport, writeRpcFixtures, type RpcFixtures } from "../src/fixtures.js";
import { ERC20_ABI, ETH_USD_FEED, FEED_ABI, TOKENS } from "../src/tokens.js";
import { PINNED_BLOCK } from "./fork-expected.js";

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

}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
