// Values read from Base at the pinned block, recorded 2026-09-26 from an anvil
// fork (anvil --fork-url https://mainnet.base.org --fork-block-number 51800000)
// and cross-read with `cast balance` / `cast call`. Archive state at a fixed
// block does not change, so these are exact.

export const PINNED_BLOCK = 51_800_000n;

export const EXPECTED = {
  chain_id: 8453,
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  holders: {
    weth_contract: {
      address: "0x4200000000000000000000000000000000000006",
      eth_wei: 263597196816461051072736n,
      usdc_base_units: 167551481n,
    },
    burn: {
      address: "0x000000000000000000000000000000000000dEaD",
      eth_wei: 4441218380009809538n,
      usdc_base_units: 25896806146n,
    },
  },
} as const;
