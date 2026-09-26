// Read-only market data: block and gas from the RPC, ETH/USD from the Chainlink
// feed through the kit's chain.read action. Nothing here writes to the chain.

import { formatUnits } from "viem";
import type { Runtime } from "./runtime.js";
import { ACTIONS, fragment, type ChainReadInput, type ChainReadOutput } from "./kit-io.js";
import { ETH_USD_FEED, FEED_ABI } from "./tokens.js";
import type { MarketView } from "./model.js";

export type MarketSnapshot = MarketView & {
  chain: string;
  eth_usd_feed: string;
  eth_usd_updated_at: string | null;
};

export async function readMarket(rt: Runtime): Promise<MarketSnapshot> {
  const [block, gasPrice] = await Promise.all([rt.client.getBlockNumber(), rt.client.getGasPrice()]);
  const feed = ETH_USD_FEED[rt.chain];
  const read = async <O>(name: string): Promise<O> =>
    (await rt.kit.read<ChainReadOutput<O>>(ACTIONS.chainRead, { kind: "contract_read", chain: rt.chain, contract: feed, abi: fragment(FEED_ABI, name) } satisfies ChainReadInput)).result;
  const [decimals, description, round] = await Promise.all([
    read<number | string>("decimals"),
    read<string>("description"),
    read<readonly [string, string, string, string, string]>("latestRoundData"),
  ]);
  const dec = Number(decimals);
  const answer = BigInt(String(round[1]));
  const updatedAt = Number(String(round[3]));
  return {
    chain: rt.chain,
    block: block.toString(),
    gas_price_gwei: formatUnits(gasPrice, 9),
    eth_usd: answer > 0n ? Number(formatUnits(answer, dec)) : null,
    eth_usd_feed: `${description} (${feed})`,
    eth_usd_updated_at: Number.isFinite(updatedAt) && updatedAt > 0 ? new Date(updatedAt * 1000).toISOString() : null,
  };
}
