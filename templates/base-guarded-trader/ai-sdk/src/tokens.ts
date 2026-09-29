// Addresses this template knows about. Every one is public and on-chain; none
// of them is a key. Sources are linked so a reader can check each line.

import type { Address } from "viem";

export type ChainName = "base" | "base-sepolia";
export type TokenSymbol = "USDC" | "WETH";

export const CHAIN_IDS: Record<ChainName, number> = { base: 8453, "base-sepolia": 84532 };

// Base mainnet: native USDC (https://developers.circle.com/stablecoins/usdc-contract-addresses)
// and the OP-stack WETH predeploy.
// Base Sepolia: Circle's testnet USDC and the same WETH predeploy.
export const TOKENS: Record<ChainName, Record<TokenSymbol, { address: Address; decimals: number }>> = {
  base: {
    USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
    WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
  },
  "base-sepolia": {
    USDC: { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6 },
    WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
  },
};

// Chainlink ETH / USD (https://docs.chain.link/data-feeds/price-feeds/addresses?network=base).
export const ETH_USD_FEED: Record<ChainName, Address> = {
  base: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  "base-sepolia": "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1",
};

export const FEED_ABI = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "description", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

export const ERC20_ABI = [
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;
