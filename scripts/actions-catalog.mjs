// The actions Sato Status checks every night, and how each one is checked.
//
// Chosen for demand (they are the actions onchain agents reach for: token
// balances and allowances, price feeds, protocol and token data, block reads,
// swap quotes, contract generation, and the integration skills of LI.FI,
// Uniswap, Jupiter, Helius and Polymarket) and for checkability WITHOUT
// secrets: every check below is a read — against an anvil fork of Base or
// Ethereum at a pinned block, or a public read (Solana mainnet RPC, a public
// API, a repository file) — and none needs an API key, a wallet key or a
// signature. Sources that need a key to answer at all are left out and listed
// in DROPPED with the reason.
//
// Every action names the chain its check reads (`chain`): a key of CHAINS, or
// "polygon" / "any" for a check that reads no chain of ours (a skill for a
// Polygon protocol, a multi-chain skill, an oracle feed id).
//
// An action marked `write: true` is a Sato Kit prepare (it builds an unsigned
// transaction or a proposal for a signer). It is NEVER called here: its
// record carries the schema lint of its descriptor and the custody answer
// only, and its result is "lint_only", never green.
//
// Each conformance `assert` is pure: (output, expected) → null when it passes,
// or a sentence naming what differed.

export const FORK_BLOCK = 51800000;
/** The hash of Base block 51800000. A block hash never changes. */
export const BASE_BLOCK_HASH = "0xb4402c476ad106075a654226a59ed23003ffefbdc75ce4b0afeccab2b310493c";

export const ETH_FORK_BLOCK = 23000000;
/** The hash of Ethereum block 23000000. */
export const ETH_BLOCK_HASH = "0xe368c631c74a82c3043e6d44c4bef6e6139a6501b39c7700c2552554d10e6c3b";

/**
 * The chains the checks read. EVM chains are forked with anvil at a pinned
 * block from public archive RPCs (each verified to serve state at that block);
 * Solana has no fork, so its checks are public mainnet reads.
 *
 * Arbitrum is not here: no public keyless RPC we tried serves historical state
 * (arb1.arbitrum.io: "historical state … is not available"; arbitrum.drpc.org:
 * "Unknown state"; publicnode: archive needs a token), so a pinned-block fork
 * could not start without a key.
 */
export const CHAINS = {
  base: {
    kind: "evm", chain_id: 8453, fork_block: FORK_BLOCK, block_hash: BASE_BLOCK_HASH, port: 8547,
    archive_rpcs: ["https://mainnet.base.org", "https://base.drpc.org"], agentkit_network: "base-mainnet",
  },
  ethereum: {
    kind: "evm", chain_id: 1, fork_block: ETH_FORK_BLOCK, block_hash: ETH_BLOCK_HASH, port: 8548,
    archive_rpcs: ["https://eth.drpc.org", "https://eth-mainnet.public.blastapi.io"], agentkit_network: "ethereum-mainnet",
  },
  solana: { kind: "svm", public_rpc: "https://api.mainnet-beta.solana.com", agentkit_network: "solana-mainnet" },
};
/** Every value an action's `chain` may take. */
export const CHAIN_VALUES = [...Object.keys(CHAINS), "base-sepolia", "polygon", "any"];

export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const WETH_BASE = "0x4200000000000000000000000000000000000006";
/** A contract that holds USDC on Base at the pinned block (Morpho Blue). Used only as an address to read. */
export const HOLDER = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export const PYTH_ETH_USD = "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";
/** The Basenames registrar (ERC-721) on Base. */
export const BASENAMES_BASE = "0x03c4738Ee98aE44591e1A4A4F3CaB6641d95DD9a";

export const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const WETH_ETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
/** An address that holds USDC and ETH on Ethereum at the pinned block. Used only as an address to read. */
export const HOLDER_ETH = "0x37305B1cD40574E4C5Ce33f8e8306Be057fD7341";
/** The ENS base registrar (ERC-721) on Ethereum. */
export const ENS_REGISTRAR_ETH = "0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85";

/** A Safe on Base Sepolia (threshold 1), read from the public Safe Transaction Service; the kit's safe.info fixture records the same Safe. */
export const SAFE_BASE_SEPOLIA = "0x981778Bc0E01C87973c448bc2A866609961D05b4";
/** USDC on Arbitrum One, the destination of the bridge quote. */
export const USDC_ARBITRUM = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

export const USDC_SOLANA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** A Solana address used only to read its USDC balance (the check reads the shape of the answer, not its value). */
export const SOLANA_OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const DEXPAPRIKA_RATIONALE = "Nightly Sato Status conformance check: one public read to confirm this tool answers.";

export const SOURCES = {
  agentkit: {
    kind: "agentkit-provider",
    package: "@coinbase/agentkit",
    repo_url: "https://github.com/coinbase/agentkit",
    runner: "library",
    install: ["@coinbase/agentkit@latest", "viem@2", "zod-to-json-schema@3"],
    custody: { kind: "package", target: "@coinbase/agentkit" },
  },
  "evm-mcp-server": {
    kind: "protocol-mcp",
    package: "@mcpdotdirect/evm-mcp-server",
    repo_url: "https://github.com/mcpdotdirect/evm-mcp-server",
    runner: "mcp",
    install: ["@mcpdotdirect/evm-mcp-server@latest"],
    bin: "evm-mcp-server",
    custody: { kind: "package", target: "@mcpdotdirect/evm-mcp-server" },
  },
  "dexpaprika-mcp": {
    kind: "protocol-mcp",
    package: "dexpaprika-mcp",
    repo_url: "https://github.com/coinpaprika/dexpaprika-mcp",
    runner: "mcp",
    install: ["dexpaprika-mcp@latest"],
    bin: "dexpaprika-mcp",
    custody: { kind: "package", target: "dexpaprika-mcp" },
  },
  "openzeppelin-contracts-mcp": {
    kind: "protocol-mcp",
    package: "@openzeppelin/contracts-mcp",
    repo_url: "https://github.com/OpenZeppelin/contracts-wizard",
    runner: "mcp",
    install: ["@openzeppelin/contracts-mcp@latest"],
    bin: "contracts-mcp",
    custody: { kind: "package", target: "@openzeppelin/contracts-mcp" },
  },
  "uniswap-ai": {
    kind: "skill",
    package: "github:Uniswap/uniswap-ai",
    repo_url: "https://github.com/Uniswap/uniswap-ai",
    runner: "skill",
    github: { owner: "Uniswap", repo: "uniswap-ai", branch: "main" },
    custody: { kind: "skill", target: "Uniswap/uniswap-ai" },
  },
  "lifi-agent-skills": {
    kind: "skill",
    package: "github:lifinance/lifi-agent-skills",
    repo_url: "https://github.com/lifinance/lifi-agent-skills",
    runner: "skill",
    github: { owner: "lifinance", repo: "lifi-agent-skills", branch: "main" },
    custody: { kind: "skill", target: "lifinance/lifi-agent-skills" },
  },
  "jupiter-agent-skills": {
    kind: "skill",
    package: "github:jup-ag/agent-skills",
    repo_url: "https://github.com/jup-ag/agent-skills",
    runner: "skill",
    github: { owner: "jup-ag", repo: "agent-skills", branch: "main" },
    custody: { kind: "skill", target: "jup-ag/agent-skills" },
  },
  "helius-core-ai": {
    kind: "skill",
    package: "github:helius-labs/core-ai",
    repo_url: "https://github.com/helius-labs/core-ai",
    runner: "skill",
    github: { owner: "helius-labs", repo: "core-ai", branch: "main" },
    custody: { kind: "skill", target: "helius-labs/core-ai" },
  },
  "polymarket-agent-skills": {
    kind: "skill",
    package: "github:Polymarket/agent-skills",
    repo_url: "https://github.com/Polymarket/agent-skills",
    runner: "skill",
    github: { owner: "Polymarket", repo: "agent-skills", branch: "main" },
    custody: { kind: "skill", target: "Polymarket/agent-skills" },
  },
  "sato-kit": {
    kind: "sato-kit",
    package: "@satohub/kit",
    repo_url: "https://github.com/satohubai/sato-hub-integrations",
    runner: "library",
    // Unpublished: the preview tarball the templates vendor.
    install: ["./vendor/satohub-kit-0.1.0.tgz", "viem@2"],
    vendor: "templates/base-guarded-trader/plain-ts/vendor/satohub-kit-0.1.0.tgz",
    custody: { kind: "package", target: "@satohub/kit" },
  },
};

/**
 * Asked for by demand, and left out because a check could not run without a
 * secret (or at all). Listed so the omission is visible, never silent.
 */
export const DROPPED = [
  { name: "Alchemy MCP server", package: "@alchemy/mcp-server", reason: "every tool calls Alchemy's API with ALCHEMY_API_KEY; there is no keyless read" },
  { name: "Helius MCP server", package: "helius-mcp", reason: "the tools call Helius RPC/DAS with HELIUS_API_KEY; the Helius skills are checked instead" },
  { name: "1inch MCP server", package: "1inch-mcp", reason: "the only npm package links no repository (publisher not verifiable), and the 1inch Developer Portal API it wraps needs an API key" },
  { name: "Jupiter MCP server", package: "jupiter-mcp", reason: "it starts only with a Solana private key (it executes swaps); the Jupiter skills are checked instead" },
  { name: "Solana Agent Kit MCP", package: "solana-mcp", reason: "it starts only with SOLANA_PRIVATE_KEY and an RPC URL" },
  { name: "Base MCP", package: "base-mcp", reason: "deprecated upstream (its bin is deprecated.js) and needs CDP API keys and a seed phrase" },
  { name: "LI.FI MCP servers", package: "(community)", reason: "no LI.FI-published MCP server package on npm (checked @lifi/mcp, @lifi/mcp-server, lifi-mcp); LI.FI's own agent skills are checked instead" },
  { name: "CoinGecko MCP", package: "@coingecko/coingecko-mcp", reason: "a code-execution server (execute / search_docs) configured with COINGECKO_PRO_API_KEY or COINGECKO_DEMO_API_KEY" },
  { name: "AgentKit zeroX / messari / zerion / vaultsfyi / alchemyTokenPrices", package: "@coinbase/agentkit", reason: "each provider refuses to construct without its API key" },
  { name: "evm-mcp-server on Ethereum", package: "@mcpdotdirect/evm-mcp-server", reason: "its Ethereum reads go to a hard-coded eth.llamarpc.com that did not answer when catalogued, and a server gets no env to point it elsewhere; its Base reads stay" },
  { name: "Arbitrum fork reads", package: "(chain)", reason: "no public keyless RPC serves Arbitrum historical state, so a pinned-block fork cannot start without a key; Solana is the third chain" },
];

// ── pure assertion helpers ───────────────────────────────────────────────────

export function textOf(output) {
  if (typeof output === "string") return output;
  if (output && Array.isArray(output.content)) return output.content.filter((c) => c?.type === "text").map((c) => c.text).join("\n");
  return JSON.stringify(output ?? null);
}

function jsonOf(output) {
  if (output && typeof output === "object" && !Array.isArray(output.content)) return output;
  if (output && output.structuredContent) return output.structuredContent;
  try { return JSON.parse(textOf(output)); } catch { return null; }
}

/** 123456789n, 6 → "123.456789" (no trailing zeros, no thousands separators). */
export function formatUnits(raw, decimals) {
  const v = BigInt(raw);
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

function isMcpError(output) {
  return Boolean(output && output.isError);
}

function nativeBalanceAssert(chainId) {
  return (output, exp) => {
    const t = textOf(output);
    if (!new RegExp(`Chain ID:\\s*${chainId}\\b`).test(t)) return `expected the wallet details for chain ${chainId}; got: ${t.slice(0, 200)}`;
    return new RegExp(`(^|[^0-9])${exp.value} WEI`).test(t) ? null : `the fork holds ${exp.value} wei for the address; the action returned: ${t.slice(0, 200)}`;
  };
}

function nftBalanceAssert(output, exp) {
  const t = textOf(output);
  return new RegExp(`is ${exp.value}$`).test(t.trim()) ? null : `the fork has an ERC-721 balance of ${exp.value}; the action returned: ${t.slice(0, 200)}`;
}

function tokenAddressAssert(address) {
  return (output) => {
    const t = textOf(output);
    return t.toLowerCase().includes(address.toLowerCase()) ? null : `expected the USDC address ${address}; got: ${t.slice(0, 200)}`;
  };
}

function foundTokenAssert(address) {
  return (output) => {
    const t = textOf(output);
    return /^Found [0-9]+ tokens/.test(t.trim()) && t.toLowerCase().includes(address.toLowerCase()) ? null : `expected a token list that includes ${address}; got: ${t.slice(0, 200)}`;
  };
}

function sushiQuoteAssert(buyToken) {
  return (output) => {
    const t = textOf(output);
    if (!t.toLowerCase().includes(buyToken.toLowerCase())) return `expected a quote into ${buyToken}; got: ${t.slice(0, 200)}`;
    const m = t.match(/AmountOut:\s*([0-9.]+)/);
    return m && Number(m[1]) > 0 ? null : `expected a positive AmountOut; got: ${t.slice(0, 200)}`;
  };
}

// ── the actions ──────────────────────────────────────────────────────────────

export const ACTIONS = [
  // Coinbase AgentKit action providers (the read-only ones).
  {
    id: "agentkit-provider:erc20.get_balance",
    name: "ERC20ActionProvider_get_balance",
    source: "agentkit",
    chain: "base",
    provider: "erc20ActionProvider",
    needs_fork: true,
    args: { tokenAddress: USDC_BASE, address: HOLDER },
    expected: { kind: "erc20_balance", token: USDC_BASE, owner: HOLDER, decimals: 6 },
    assert(output, exp) {
      const t = textOf(output);
      const want = formatUnits(exp.value, 6);
      return t.includes(want) ? null : `the fork holds ${want} USDC for the holder; the action returned: ${t.slice(0, 200)}`;
    },
  },
  {
    id: "agentkit-provider:erc20.get_allowance",
    name: "ERC20ActionProvider_get_allowance",
    source: "agentkit",
    chain: "base",
    provider: "erc20ActionProvider",
    needs_fork: true,
    wallet_address: HOLDER,
    args: { tokenAddress: USDC_BASE, spenderAddress: PERMIT2 },
    expected: { kind: "erc20_allowance", token: USDC_BASE, owner: HOLDER, spender: PERMIT2, decimals: 6 },
    assert(output, exp) {
      const t = textOf(output);
      const want = formatUnits(exp.value, 6);
      return new RegExp(`(^|[^0-9.])${want.replace(".", "\\.")}([^0-9]|$)`).test(t) ? null : `the fork has an allowance of ${want}; the action returned: ${t.slice(0, 200)}`;
    },
  },
  {
    id: "agentkit-provider:pyth.fetch_price_feed",
    name: "PythActionProvider_fetch_price_feed",
    source: "agentkit",
    chain: "any",
    provider: "pythActionProvider",
    args: { tokenSymbol: "ETH", quoteCurrency: "USD", assetType: "crypto" },
    assert(output) {
      const t = textOf(output).toLowerCase();
      return t.includes(PYTH_ETH_USD.slice(2)) ? null : `expected the Pyth ETH/USD feed id; got: ${t.slice(0, 200)}`;
    },
  },
  {
    id: "agentkit-provider:pyth.fetch_price",
    name: "PythActionProvider_fetch_price",
    source: "agentkit",
    chain: "any",
    provider: "pythActionProvider",
    args: { priceFeedID: PYTH_ETH_USD },
    assert(output) {
      const t = textOf(output);
      const m = t.match(/[0-9]+(\.[0-9]+)?/);
      return m && Number(m[0]) > 0 ? null : `expected a positive price; got: ${t.slice(0, 200)}`;
    },
  },
  {
    id: "agentkit-provider:defillama.find_protocol",
    name: "DefiLlamaActionProvider_find_protocol",
    source: "agentkit",
    chain: "any",
    provider: "defillamaActionProvider",
    args: { query: "uniswap" },
    assert(output) {
      const t = textOf(output);
      return /uniswap/i.test(t) && !/^error/i.test(t.trim()) ? null : `expected a protocol match for "uniswap"; got: ${t.slice(0, 200)}`;
    },
  },
  {
    id: "agentkit-provider:defillama.get_token_prices",
    name: "DefiLlamaActionProvider_get_token_prices",
    source: "agentkit",
    chain: "base",
    provider: "defillamaActionProvider",
    args: { tokens: [`base:${USDC_BASE}`] },
    assert(output) {
      const t = textOf(output);
      return /"price"\s*:\s*[0-9]/.test(t) ? null : `expected a price for Base USDC; got: ${t.slice(0, 200)}`;
    },
  },

  // Protocol MCP servers, run locally over stdio.
  {
    id: "protocol-mcp:evm-mcp-server.get_block",
    name: "get_block",
    source: "evm-mcp-server",
    chain: "base",
    args: { blockIdentifier: String(FORK_BLOCK), network: "base" },
    assert(output) {
      if (isMcpError(output)) return `the tool answered an error: ${textOf(output).slice(0, 200)}`;
      const j = jsonOf(output);
      if (!j) return "the tool answered text that is not JSON";
      if (String(j.number) !== String(FORK_BLOCK)) return `expected block ${FORK_BLOCK}, got ${j.number}`;
      return String(j.hash).toLowerCase() === BASE_BLOCK_HASH ? null : `block ${FORK_BLOCK} hash ${j.hash} is not the chain's ${BASE_BLOCK_HASH}`;
    },
  },
  {
    id: "protocol-mcp:evm-mcp-server.get_chain_info",
    name: "get_chain_info",
    source: "evm-mcp-server",
    chain: "base",
    args: { network: "base" },
    assert(output) {
      if (isMcpError(output)) return `the tool answered an error: ${textOf(output).slice(0, 200)}`;
      const j = jsonOf(output);
      return j && Number(j.chainId) === 8453 ? null : `expected chainId 8453 for base; got: ${textOf(output).slice(0, 200)}`;
    },
  },
  {
    id: "protocol-mcp:dexpaprika-mcp.getNetworks",
    name: "getNetworks",
    source: "dexpaprika-mcp",
    chain: "any",
    args: { rationale: DEXPAPRIKA_RATIONALE },
    assert(output) {
      if (isMcpError(output)) return `the tool answered an error: ${textOf(output).slice(0, 200)}`;
      return /"(id|slug)"\s*:\s*"base"/.test(textOf(output)) || /"base"/.test(JSON.stringify(jsonOf(output))) ? null : "expected the network list to include base";
    },
  },
  {
    id: "protocol-mcp:dexpaprika-mcp.getTokenDetails",
    name: "getTokenDetails",
    source: "dexpaprika-mcp",
    chain: "base",
    args: { network: "base", token_address: USDC_BASE.toLowerCase(), rationale: DEXPAPRIKA_RATIONALE },
    assert(output) {
      if (isMcpError(output)) return `the tool answered an error: ${textOf(output).slice(0, 200)}`;
      return /"symbol"\s*:\s*"USDC"/.test(textOf(output)) || /"symbol":"USDC"/.test(JSON.stringify(jsonOf(output))) ? null : "expected symbol USDC for Base USDC";
    },
  },
  {
    id: "protocol-mcp:openzeppelin-contracts-mcp.solidity-erc20",
    name: "solidity-erc20",
    source: "openzeppelin-contracts-mcp",
    chain: "any",
    args: { name: "Example", symbol: "EX" },
    assert(output) {
      if (isMcpError(output)) return `the tool answered an error: ${textOf(output).slice(0, 200)}`;
      return /contract Example is ERC20\b/.test(textOf(output)) ? null : "expected a contract `Example is ERC20` in the generated source";
    },
  },

  // Skills: the SKILL.md at the repository's current commit must parse and
  // name itself as its directory does.
  { id: "skill:uniswap-ai.swap-integration", name: "swap-integration", source: "uniswap-ai", chain: "any", path: "packages/plugins/uniswap-trading/skills/swap-integration/SKILL.md" },
  { id: "skill:uniswap-ai.swap-planner", name: "swap-planner", source: "uniswap-ai", chain: "any", path: "packages/plugins/uniswap-driver/skills/swap-planner/SKILL.md" },
  { id: "skill:uniswap-ai.viem-integration", name: "viem-integration", source: "uniswap-ai", chain: "any", path: "packages/plugins/uniswap-viem/skills/viem-integration/SKILL.md" },

  // ── AgentKit: more read-only providers, on Base and on Ethereum ─────────────
  {
    id: "agentkit-provider:wallet.get_wallet_details",
    name: "WalletActionProvider_get_wallet_details",
    source: "agentkit",
    chain: "base",
    provider: "walletActionProvider",
    needs_fork: true,
    wallet_address: WETH_BASE,
    args: {},
    expected: { kind: "native_balance", owner: WETH_BASE },
    assert: nativeBalanceAssert(8453),
  },
  {
    id: "agentkit-provider:erc721.get_balance",
    name: "Erc721ActionProvider_get_balance",
    source: "agentkit",
    chain: "base",
    provider: "erc721ActionProvider",
    needs_fork: true,
    args: { contractAddress: BASENAMES_BASE, address: HOLDER },
    expected: { kind: "erc721_balance", token: BASENAMES_BASE, owner: HOLDER },
    assert: nftBalanceAssert,
  },
  {
    id: "agentkit-provider:erc20.get_erc20_token_address",
    name: "ERC20ActionProvider_get_erc20_token_address",
    source: "agentkit",
    chain: "base",
    provider: "erc20ActionProvider",
    args: { symbol: "USDC" },
    assert: tokenAddressAssert(USDC_BASE),
  },
  {
    id: "agentkit-provider:sushi-data.find-token",
    name: "SushiDataActionProvider_find-token",
    source: "agentkit",
    chain: "base",
    provider: "sushiDataActionProvider",
    args: { search: "USDC" },
    assert: foundTokenAssert(USDC_BASE),
  },
  {
    id: "agentkit-provider:sushi-router.quote",
    name: "SushiRouterActionProvider_quote",
    source: "agentkit",
    chain: "base",
    provider: "sushiRouterActionProvider",
    needs_fork: true,
    wallet_address: HOLDER,
    args: { fromAssetAddress: USDC_BASE, toAssetAddress: WETH_BASE, amount: "1" },
    assert: sushiQuoteAssert(WETH_BASE),
  },
  {
    id: "agentkit-provider:truemarkets.get_prediction_markets",
    name: "TrueMarketsActionProvider_get_prediction_markets",
    source: "agentkit",
    chain: "base",
    provider: "truemarketsActionProvider",
    needs_fork: true,
    args: { limit: 2, offset: 0, sortOrder: "desc" },
    assert(output) {
      const j = jsonOf(output);
      return j && j.success === true && Array.isArray(j.markets) && j.markets.length > 0 && Number(j.totalMarkets) > 0 ? null : `expected success with a non-empty market list read from the fork; got: ${textOf(output).slice(0, 200)}`;
    },
  },
  {
    id: "agentkit-provider:erc20.get_balance.ethereum",
    name: "ERC20ActionProvider_get_balance",
    source: "agentkit",
    chain: "ethereum",
    provider: "erc20ActionProvider",
    needs_fork: true,
    args: { tokenAddress: USDC_ETH, address: HOLDER_ETH },
    expected: { kind: "erc20_balance", token: USDC_ETH, owner: HOLDER_ETH, decimals: 6 },
    assert(output, exp) {
      const t = textOf(output);
      const want = formatUnits(exp.value, 6);
      return t.includes(want) ? null : `the fork holds ${want} USDC for the holder; the action returned: ${t.slice(0, 200)}`;
    },
  },
  {
    id: "agentkit-provider:erc20.get_allowance.ethereum",
    name: "ERC20ActionProvider_get_allowance",
    source: "agentkit",
    chain: "ethereum",
    provider: "erc20ActionProvider",
    needs_fork: true,
    wallet_address: HOLDER_ETH,
    args: { tokenAddress: USDC_ETH, spenderAddress: PERMIT2 },
    expected: { kind: "erc20_allowance", token: USDC_ETH, owner: HOLDER_ETH, spender: PERMIT2, decimals: 6 },
    assert(output, exp) {
      const t = textOf(output);
      const want = formatUnits(exp.value, 6);
      return new RegExp(`(^|[^0-9.])${want.replace(".", "\\.")}([^0-9]|$)`).test(t) ? null : `the fork has an allowance of ${want}; the action returned: ${t.slice(0, 200)}`;
    },
  },
  {
    id: "agentkit-provider:wallet.get_wallet_details.ethereum",
    name: "WalletActionProvider_get_wallet_details",
    source: "agentkit",
    chain: "ethereum",
    provider: "walletActionProvider",
    needs_fork: true,
    wallet_address: HOLDER_ETH,
    args: {},
    expected: { kind: "native_balance", owner: HOLDER_ETH },
    assert: nativeBalanceAssert(1),
  },
  {
    id: "agentkit-provider:erc721.get_balance.ethereum",
    name: "Erc721ActionProvider_get_balance",
    source: "agentkit",
    chain: "ethereum",
    provider: "erc721ActionProvider",
    needs_fork: true,
    args: { contractAddress: ENS_REGISTRAR_ETH, address: HOLDER_ETH },
    expected: { kind: "erc721_balance", token: ENS_REGISTRAR_ETH, owner: HOLDER_ETH },
    assert: nftBalanceAssert,
  },
  {
    id: "agentkit-provider:erc20.get_erc20_token_address.ethereum",
    name: "ERC20ActionProvider_get_erc20_token_address",
    source: "agentkit",
    chain: "ethereum",
    provider: "erc20ActionProvider",
    args: { symbol: "USDC" },
    assert: tokenAddressAssert(USDC_ETH),
  },
  {
    id: "agentkit-provider:sushi-data.find-token.ethereum",
    name: "SushiDataActionProvider_find-token",
    source: "agentkit",
    chain: "ethereum",
    provider: "sushiDataActionProvider",
    args: { search: "USDC" },
    assert: foundTokenAssert(USDC_ETH),
  },
  {
    id: "agentkit-provider:sushi-router.quote.ethereum",
    name: "SushiRouterActionProvider_quote",
    source: "agentkit",
    chain: "ethereum",
    provider: "sushiRouterActionProvider",
    needs_fork: true,
    wallet_address: HOLDER_ETH,
    args: { fromAssetAddress: USDC_ETH, toAssetAddress: WETH_ETH, amount: "1" },
    assert: sushiQuoteAssert(WETH_ETH),
  },
  // AgentKit on Solana: the SPL provider reads through a read-only Solana
  // wallet provider whose connection is the public mainnet RPC.
  {
    id: "agentkit-provider:spl.get_balance.solana",
    name: "SplActionProvider_get_balance",
    source: "agentkit",
    chain: "solana",
    provider: "splActionProvider",
    wallet_address: SOLANA_OWNER,
    args: { mintAddress: USDC_SOLANA, address: SOLANA_OWNER },
    assert(output) {
      const t = textOf(output);
      return new RegExp(`^Balance for ${SOLANA_OWNER} is [0-9]+(\\.[0-9]+)?(e[-+]?[0-9]+)? tokens$`).test(t.trim()) ? null : `expected "Balance for ${SOLANA_OWNER} is <n> tokens"; got: ${t.slice(0, 200)}`;
    },
  },

  // ── DexPaprika on Ethereum and Solana ───────────────────────────────────────
  {
    id: "protocol-mcp:dexpaprika-mcp.getTokenDetails.ethereum",
    name: "getTokenDetails",
    source: "dexpaprika-mcp",
    chain: "ethereum",
    args: { network: "ethereum", token_address: USDC_ETH.toLowerCase(), rationale: DEXPAPRIKA_RATIONALE },
    assert(output) {
      if (isMcpError(output)) return `the tool answered an error: ${textOf(output).slice(0, 200)}`;
      const j = jsonOf(output);
      return j && j.symbol === "USDC" && Number(j.decimals) === 6 ? null : "expected symbol USDC with 6 decimals for Ethereum USDC";
    },
  },
  {
    id: "protocol-mcp:dexpaprika-mcp.getTokenDetails.solana",
    name: "getTokenDetails",
    source: "dexpaprika-mcp",
    chain: "solana",
    args: { network: "solana", token_address: USDC_SOLANA, rationale: DEXPAPRIKA_RATIONALE },
    // decimals compared with the mint account read from Solana mainnet.
    expected: { kind: "spl_mint", mint: USDC_SOLANA },
    assert(output, exp) {
      if (isMcpError(output)) return `the tool answered an error: ${textOf(output).slice(0, 200)}`;
      const j = jsonOf(output);
      if (!j || j.symbol !== "USDC") return "expected symbol USDC for Solana USDC";
      return Number(j.decimals) === Number(exp.value) ? null : `the mint account on Solana has ${exp.value} decimals; the tool answered ${j.decimals}`;
    },
  },
  {
    id: "protocol-mcp:dexpaprika-mcp.getNetworkDexes.solana",
    name: "getNetworkDexes",
    source: "dexpaprika-mcp",
    chain: "solana",
    args: { network: "solana", rationale: DEXPAPRIKA_RATIONALE },
    assert(output) {
      if (isMcpError(output)) return `the tool answered an error: ${textOf(output).slice(0, 200)}`;
      const j = jsonOf(output);
      const dexes = Array.isArray(j?.dexes) ? j.dexes : [];
      return dexes.length > 0 && dexes.every((d) => d.chain === "solana") ? null : "expected a non-empty list of Solana DEXes";
    },
  },

  // ── Integration skills: SKILL.md at the repository's current commit ─────────
  { id: "skill:uniswap-ai.lp-integration", name: "lp-integration", source: "uniswap-ai", chain: "any", path: "packages/plugins/uniswap-trading/skills/lp-integration/SKILL.md" },
  { id: "skill:uniswap-ai.v4-sdk-integration", name: "v4-sdk-integration", source: "uniswap-ai", chain: "any", path: "packages/plugins/uniswap-trading/skills/v4-sdk-integration/SKILL.md" },
  { id: "skill:lifi-agent-skills.lifi", name: "lifi", source: "lifi-agent-skills", chain: "any", path: "skills/lifi/SKILL.md" },
  { id: "skill:lifi-agent-skills.lifi-stablecoin-swap", name: "lifi-stablecoin-swap", source: "lifi-agent-skills", chain: "any", path: "skills/lifi-stablecoin-swap/SKILL.md" },
  { id: "skill:jupiter-agent-skills.integrating-jupiter", name: "integrating-jupiter", source: "jupiter-agent-skills", chain: "solana", path: "skills/integrating-jupiter/SKILL.md" },
  { id: "skill:jupiter-agent-skills.jupiter-lend", name: "jupiter-lend", source: "jupiter-agent-skills", chain: "solana", path: "skills/jupiter-lend/SKILL.md" },
  { id: "skill:jupiter-agent-skills.jupiter-swap-migration", name: "jupiter-swap-migration", source: "jupiter-agent-skills", chain: "solana", path: "skills/jupiter-swap-migration/SKILL.md" },
  { id: "skill:helius-core-ai.helius", name: "helius", source: "helius-core-ai", chain: "solana", path: "helius-skills/helius/SKILL.md" },
  { id: "skill:helius-core-ai.svm", name: "svm", source: "helius-core-ai", chain: "solana", path: "helius-skills/svm/SKILL.md" },
  { id: "skill:polymarket-agent-skills.web3-polymarket", name: "web3-polymarket", source: "polymarket-agent-skills", chain: "polygon", path: "SKILL.md" },

  // Our own core five — the reference consumer, checked the same way.
  {
    id: "sato-kit:chain.read",
    name: "chain_read",
    source: "sato-kit",
    chain: "base",
    needs_fork: true,
    args: { kind: "erc20_balance", chain: "base", token: USDC_BASE, owner: HOLDER },
    expected: { kind: "erc20_balance", token: USDC_BASE, owner: HOLDER, decimals: 6 },
    assert(output, exp) {
      return output?.result === exp.value ? null : `the fork holds ${exp.value} base units; the action returned ${JSON.stringify(output?.result)}`;
    },
  },
  {
    id: "sato-kit:erc8004.lookup",
    name: "erc8004_lookup",
    source: "sato-kit",
    chain: "base",
    needs_fork: true,
    args: { chain: "base", agent_id: "1" },
    assert(output) {
      return output && typeof output.registered === "boolean" && output.by === "agent_id" ? null : `expected a registered true/false answer; got ${JSON.stringify(output).slice(0, 200)}`;
    },
  },
  {
    id: "sato-kit:swap.quote",
    name: "swap_quote",
    source: "sato-kit",
    chain: "base",
    needs_fork: true,
    args: { chain: "base", sell_token: USDC_BASE, buy_token: WETH_BASE, sell_amount: "1000000", venue: "lifi" },
    assert(output) {
      const s = JSON.stringify(output ?? null);
      return /"buy_amount":"[0-9]+"/.test(s) ? null : `expected a quote with a buy_amount; got ${s.slice(0, 200)}`;
    },
  },
  {
    id: "sato-kit:swap.prepare",
    name: "swap_prepare",
    source: "sato-kit",
    chain: "base",
    needs_fork: true,
    args: { chain: "base", sell_token: USDC_BASE, buy_token: WETH_BASE, sell_amount: "1000000", taker: HOLDER, venue: "lifi" },
    assert(output) {
      return output?.unsigned?.kind === "evm_tx" && /^0x[0-9a-fA-F]{40}$/.test(output.unsigned.to ?? "") ? null : `expected an unsigned evm_tx; got ${JSON.stringify(output?.unsigned ?? null).slice(0, 200)}`;
    },
  },
  {
    id: "sato-kit:x402.prepare",
    name: "x402_prepare",
    source: "sato-kit",
    chain: "base",
    args: { url: "https://satohub.ai/api/x402/history/coinbase-agentkit", max_amount_base_units: "1000000" },
    assert(output) {
      return output?.unsigned?.kind === "x402_payment" ? null : `expected an unsigned x402_payment; got ${JSON.stringify(output?.unsigned ?? null).slice(0, 200)}`;
    },
  },
  // The kit's Phase 2 reads. Keyless, read-only; the quote goes to LI.FI
  // directly (venue "lifi") and never to satohub.ai.
  {
    id: "sato-kit:token.approvals.list",
    name: "token_approvals_list",
    source: "sato-kit",
    chain: "base",
    needs_fork: true,
    args: { chain: "base", owner: HOLDER, token: USDC_BASE, spenders: [PERMIT2] },
    expected: { kind: "erc20_allowance", token: USDC_BASE, owner: HOLDER, spender: PERMIT2 },
    assert(output, exp) {
      const a = Array.isArray(output?.approvals) ? output.approvals[0] : null;
      if (!a || String(a.spender).toLowerCase() !== PERMIT2.toLowerCase()) return `expected one approval row for ${PERMIT2}; got ${JSON.stringify(output?.approvals ?? null).slice(0, 200)}`;
      return a.allowance === exp.value ? null : `the fork holds an allowance of ${exp.value}; the action returned ${JSON.stringify(a.allowance)}`;
    },
  },
  {
    id: "sato-kit:tx.simulate",
    name: "tx_simulate",
    source: "sato-kit",
    chain: "base",
    needs_fork: true,
    // balanceOf(HOLDER) on USDC: a view call, simulated on the fork.
    args: { chain: "base", to: USDC_BASE, data: `0x70a08231${"0".repeat(24)}${HOLDER.slice(2).toLowerCase()}` },
    assert(output) {
      return output?.ok === true && /^[0-9]+$/.test(output.gas_estimate ?? "") ? null : `expected ok with a gas estimate; got ${JSON.stringify(output ?? null).slice(0, 200)}`;
    },
  },
  {
    id: "sato-kit:bridge.quote",
    name: "bridge_quote",
    source: "sato-kit",
    chain: "base",
    args: { from_chain: "base", to_chain: "arbitrum", from_token: USDC_BASE, to_token: USDC_ARBITRUM, from_amount: "1000000", from_address: HOLDER, venue: "lifi" },
    assert(output) {
      const qs = Array.isArray(output?.quotes) ? output.quotes : [];
      if (qs.some((q) => q?.venue === "sato")) return "the direct venue must not return a Sato quote";
      const q = qs.find((x) => x?.venue === "lifi");
      if (!q) return `expected a LI.FI quote; got ${JSON.stringify(output ?? null).slice(0, 200)}`;
      if (q.error) return `LI.FI answered with an error: ${String(q.error).slice(0, 200)}`;
      return /^[0-9]+$/.test(String(q.to_amount ?? "")) ? null : `expected a to_amount in base units; got ${JSON.stringify(q.to_amount)}`;
    },
  },
  {
    id: "sato-kit:safe.info",
    name: "safe_info",
    source: "sato-kit",
    chain: "base-sepolia",
    args: { chain: "base-sepolia", safe_address: SAFE_BASE_SEPOLIA },
    assert(output) {
      if (output?.safe_address !== SAFE_BASE_SEPOLIA) return `expected the Safe ${SAFE_BASE_SEPOLIA}; got ${JSON.stringify(output?.safe_address ?? null)}`;
      if (!(Number.isInteger(output.threshold) && output.threshold >= 1)) return `expected a threshold of at least 1; got ${JSON.stringify(output.threshold)}`;
      if (!Array.isArray(output.owners) || output.owners.length < output.threshold) return "expected at least threshold-many owners";
      return /^[0-9]+$/.test(String(output.nonce)) ? null : `expected a numeric nonce; got ${JSON.stringify(output.nonce)}`;
    },
  },
  {
    id: "sato-kit:solana.read",
    name: "solana_read",
    source: "sato-kit",
    chain: "solana",
    // Shape only: the balance moves, so its value is not compared.
    args: { chain: "solana", kind: "sol_balance", address: SOLANA_OWNER },
    assert(output) {
      if (output?.kind !== "sol_balance" || output.address !== SOLANA_OWNER) return `expected a sol_balance answer for ${SOLANA_OWNER}; got ${JSON.stringify(output ?? null).slice(0, 200)}`;
      return /^[0-9]+$/.test(String(output.amount)) && output.decimals === 9 ? null : `expected an amount in lamports with 9 decimals; got ${JSON.stringify({ amount: output.amount, decimals: output.decimals })}`;
    },
  },
  // The kit's prepares: schema lint + custody only, never executed.
  ...[
    ["token.approvals.revoke", "base"],
    ["erc8004.register", "base"],
    ["bridge.prepare", "base"],
    ["safe.propose", "base-sepolia"],
    ["solana.transfer", "solana"],
    ["solana.swap.prepare", "solana"],
  ].map(([odaId, chain]) => ({ id: `sato-kit:${odaId}`, name: odaId.replace(/\./g, "_"), source: "sato-kit", chain, write: true })),
];

export function thirdParty(actions = ACTIONS) {
  return actions.filter((a) => SOURCES[a.source].kind !== "sato-kit");
}
