// Values read from Base at the pinned block, recorded 2026-09-26 from an anvil
// fork (anvil --fork-url https://mainnet.base.org --fork-block-number 51800000)
// and cross-read with `cast call`. Archive state at a fixed block does not
// change, so these are exact.

export const PINNED_BLOCK = 51_800_000n;

export const EXPECTED = {
  chain_id: 8453,
  block_timestamp: 1790389347n,
  eth_usd_feed: {
    address: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
    decimals: 8,
    description: "ETH / USD",
    round_id: 55340232221128660327n,
    answer: 269504636350n, // 2695.04636350 USD
    started_at: 1790388922n,
    updated_at: 1790388935n,
    answered_in_round: 55340232221128660327n,
  },
  usdc: {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
    total_supply: 4303897166696938n, // 4,303,897,166.696938 USDC
  },
} as const;
