// The actions Sato Status checks every night, and how each one is checked.
//
// Chosen for demand (they are the actions onchain agents reach for: token
// balances and allowances, price feeds, protocol and token data, block reads,
// contract generation, swap skills) and for checkability WITHOUT secrets: every
// check below is a read — against an anvil fork of Base at the pinned block,
// or a public read — and none needs an API key, a wallet key or a signature.
// Sources that need a key to answer at all are left out (see README).
//
// Each conformance `assert` is pure: (output, expected) → null when it passes,
// or a sentence naming what differed.

export const FORK_BLOCK = 51800000;
/** The hash of Base block 51800000. A block hash never changes. */
export const BASE_BLOCK_HASH = "0xb4402c476ad106075a654226a59ed23003ffefbdc75ce4b0afeccab2b310493c";

export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const WETH_BASE = "0x4200000000000000000000000000000000000006";
/** A contract that holds USDC on Base at the pinned block (Morpho Blue). Used only as an address to read. */
export const HOLDER = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export const PYTH_ETH_USD = "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";

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

// ── the actions ──────────────────────────────────────────────────────────────

export const ACTIONS = [
  // Coinbase AgentKit action providers (the read-only ones).
  {
    id: "agentkit-provider:erc20.get_balance",
    name: "ERC20ActionProvider_get_balance",
    source: "agentkit",
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
    args: { name: "Example", symbol: "EX" },
    assert(output) {
      if (isMcpError(output)) return `the tool answered an error: ${textOf(output).slice(0, 200)}`;
      return /contract Example is ERC20\b/.test(textOf(output)) ? null : "expected a contract `Example is ERC20` in the generated source";
    },
  },

  // Skills: the SKILL.md at the repository's current commit must parse and
  // name itself as its directory does.
  { id: "skill:uniswap-ai.swap-integration", name: "swap-integration", source: "uniswap-ai", path: "packages/plugins/uniswap-trading/skills/swap-integration/SKILL.md" },
  { id: "skill:uniswap-ai.swap-planner", name: "swap-planner", source: "uniswap-ai", path: "packages/plugins/uniswap-driver/skills/swap-planner/SKILL.md" },
  { id: "skill:uniswap-ai.viem-integration", name: "viem-integration", source: "uniswap-ai", path: "packages/plugins/uniswap-viem/skills/viem-integration/SKILL.md" },

  // Our own core five — the reference consumer, checked the same way.
  {
    id: "sato-kit:chain.read",
    name: "chain_read",
    source: "sato-kit",
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
    args: { url: "https://satohub.ai/api/x402/history/coinbase-agentkit", max_amount_base_units: "1000000" },
    assert(output) {
      return output?.unsigned?.kind === "x402_payment" ? null : `expected an unsigned x402_payment; got ${JSON.stringify(output?.unsigned ?? null).slice(0, 200)}`;
    },
  },
];

export function thirdParty(actions = ACTIONS) {
  return actions.filter((a) => SOURCES[a.source].kind !== "sato-kit");
}
