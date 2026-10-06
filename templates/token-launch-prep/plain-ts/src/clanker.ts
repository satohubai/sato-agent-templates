// Clanker v4: the contract addresses, the ABI fragments and the one function
// that turns a validated launch input into the UNSIGNED `deployToken` call.
//
// SOURCES. Every address and default below is copied from the published
// clanker-sdk 4.2.19 (npm, MIT, https://github.com/clanker-devco/clanker-sdk):
// `clankerConfigFor(chainId, "clanker_v4")`, `clankerTokenV4` and
// `clankerTokenV4Converter` in dist/v4/index.js. The Base and Base Sepolia
// hook, airdrop and factory addresses also appear on Clanker's own deployed
// contracts page (CLANKER_SOURCES). This template does NOT depend on the SDK:
// the SDK ships a signing path (`deployToken` calls viem's writeContract), and
// this template has no signing path at all. It builds the same call with viem's
// encoders and nothing else.
//
// WHAT IS NOT OFFERED. Dev buy, vault, airdrop and presale extensions, dynamic
// fees, custom paired tokens and extra reward recipients are not built here.
// `value` is always 0: the deploy sends no ETH beyond the gas you pay.
//
// Pure: no network, no clock, no key.

import { encodeAbiParameters, encodeFunctionData, getAddress, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { REWARD_TOKEN_CODES, type RewardRecipient } from "./rewards.js";

export type LaunchChain = "base" | "base-sepolia";

export type ClankerChainConfig = {
  chain: LaunchChain;
  chain_id: number;
  /** The Clanker v4 factory: the `to` of the deploy. */
  factory: Address;
  /** The LP locker that holds the pool position and its reward split. */
  locker: Address;
  /** Where the recipients' LP fees accrue and are claimed from. Informational; the deploy does not name it. */
  fee_locker: Address;
  /** The v4.1 static-fee hook (pool fees set at deploy). */
  static_fee_hook: Address;
  mev_module: Address;
  /** True where the SDK encodes the v4.1 sniper-auction init data for this chain's MEV module. */
  mev_module_takes_sniper_fees: boolean;
  /** The paired token (WETH). */
  weth: Address;
};

/** clanker-sdk 4.2.19 `clanker_v4` (Base) and `clanker_v4_sepolia` (Base Sepolia), verbatim. */
export const CLANKER_V4: Readonly<Record<LaunchChain, ClankerChainConfig>> = {
  base: {
    chain: "base",
    chain_id: 8453,
    factory: "0xE85A59c628F7d27878ACeB4bf3b35733630083a9",
    locker: "0xffA37784D619F228D8B379d287a4D7282e500762",
    fee_locker: "0xF3622742b1E446D92e45E22923Ef11C2fcD55D68",
    static_fee_hook: "0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC",
    mev_module: "0xebB25BB797D82CB78E1bc70406b13233c0854413",
    mev_module_takes_sniper_fees: true,
    weth: "0x4200000000000000000000000000000000000006",
  },
  "base-sepolia": {
    chain: "base-sepolia",
    chain_id: 84532,
    factory: "0xE85A59c628F7d27878ACeB4bf3b35733630083a9",
    locker: "0x824bB048a5EC6e06a09aEd115E9eEA4618DC2c8f",
    fee_locker: "0x42A95190B4088C88Dd904d930c79deC1158bF09D",
    static_fee_hook: "0x11b51DBC2f7F683b81CeDa83DC0078D57bA328cc",
    mev_module: "0x261fE99C4D0D41EE8d0e594D11aec740E8354ab0",
    mev_module_takes_sniper_fees: false,
    weth: "0x4200000000000000000000000000000000000006",
  },
};

export const CLANKER_SOURCES = [
  { fact: "Clanker v4 deployed contract addresses on Base and Base Sepolia", url: "https://clanker.gitbook.io/clanker-documentation/references/deployed-contracts" },
  { fact: "Clanker v4 deploy config: rewards.recipients { recipient, admin, bps, token } with bps totalling 10000", url: "https://clanker.gitbook.io/documentation/sdk-reference/v4" },
  { fact: "Addresses, defaults and the deployToken encoding mirrored from clanker-sdk 4.2.19", url: "https://github.com/clanker-devco/clanker-sdk" },
] as const;

/** Every Clanker v4 token is minted with this supply (18 decimals): 100,000,000,000 tokens. */
export const TOKEN_SUPPLY_BASE_UNITS = "100000000000000000000000000000";
export const TOKEN_DECIMALS = 18;

/** Pool presets, ticks verbatim from clanker-sdk 4.2.19 POOL_POSITIONS. */
export const POOL_PRESETS = {
  standard: [{ tickLower: -230400, tickUpper: -120000, positionBps: 10000 }],
  project: [
    { tickLower: -230400, tickUpper: -214000, positionBps: 1000 },
    { tickLower: -214000, tickUpper: -155000, positionBps: 5000 },
    { tickLower: -202000, tickUpper: -155000, positionBps: 1500 },
    { tickLower: -155000, tickUpper: -120000, positionBps: 2000 },
    { tickLower: -141000, tickUpper: -120000, positionBps: 500 },
  ],
} as const;
export type PoolPreset = keyof typeof POOL_PRESETS;

/** SDK defaults: start at tick -230400 with tick spacing 200. */
export const DEFAULT_START_TICK = -230400;
export const TICK_SPACING = 200;
/** SDK default static fee: 100 bps (1%) on each side. The SDK caps each side at 2000 bps. */
export const DEFAULT_FEE_BPS = 100;
export const MAX_FEE_BPS = 2000;
/** SDK default v4.1 sniper fee: 66.6777% decaying to 4.1673% over 15 seconds (units: Uniswap hundredths of a bip). */
export const SNIPER_FEES = { startingFee: 666777, endingFee: 41673, secondsToDecay: 15 } as const;

// ── ABI fragments (clanker-sdk 4.2.19 src/abi/v4 and v4.1) ──────────────────

export const DEPLOY_TOKEN_ABI = [
  {
    type: "function",
    name: "deployToken",
    stateMutability: "payable",
    inputs: [
      {
        name: "deploymentConfig",
        type: "tuple",
        components: [
          {
            name: "tokenConfig",
            type: "tuple",
            components: [
              { name: "tokenAdmin", type: "address" },
              { name: "name", type: "string" },
              { name: "symbol", type: "string" },
              { name: "salt", type: "bytes32" },
              { name: "image", type: "string" },
              { name: "metadata", type: "string" },
              { name: "context", type: "string" },
              { name: "originatingChainId", type: "uint256" },
            ],
          },
          {
            name: "poolConfig",
            type: "tuple",
            components: [
              { name: "hook", type: "address" },
              { name: "pairedToken", type: "address" },
              { name: "tickIfToken0IsClanker", type: "int24" },
              { name: "tickSpacing", type: "int24" },
              { name: "poolData", type: "bytes" },
            ],
          },
          {
            name: "lockerConfig",
            type: "tuple",
            components: [
              { name: "locker", type: "address" },
              { name: "rewardAdmins", type: "address[]" },
              { name: "rewardRecipients", type: "address[]" },
              { name: "rewardBps", type: "uint16[]" },
              { name: "tickLower", type: "int24[]" },
              { name: "tickUpper", type: "int24[]" },
              { name: "positionBps", type: "uint16[]" },
              { name: "lockerData", type: "bytes" },
            ],
          },
          {
            name: "mevModuleConfig",
            type: "tuple",
            components: [
              { name: "mevModule", type: "address" },
              { name: "mevModuleData", type: "bytes" },
            ],
          },
          {
            name: "extensionConfigs",
            type: "tuple[]",
            components: [
              { name: "extension", type: "address" },
              { name: "msgValue", type: "uint256" },
              { name: "extensionBps", type: "uint16" },
              { name: "extensionData", type: "bytes" },
            ],
          },
        ],
      },
    ],
    outputs: [{ name: "tokenAddress", type: "address" }],
  },
] as const;

/** The factory's custom errors (clanker-sdk 4.2.19 Clanker_v4_abi), so a revert decodes to a name. */
export const CLANKER_ERRORS_ABI = [
  "Deprecated",
  "ExtensionMsgValueMismatch",
  "ExtensionNotEnabled",
  "HookNotEnabled",
  "InvalidExtension",
  "InvalidHook",
  "InvalidLocker",
  "InvalidMevModule",
  "LockerNotEnabled",
  "MaxExtensionBpsExceeded",
  "MaxExtensionsExceeded",
  "MevModuleNotEnabled",
  "NotFound",
  "OnlyNonOriginatingChains",
  "OnlyOriginatingChain",
  "Unauthorized",
].map((name) => ({ type: "error" as const, name, inputs: [] as const }));

const LOCKER_INSTANTIATION = [{ type: "tuple", components: [{ type: "uint8[]", name: "feePreference" }] }] as const;
const STATIC_FEE_INSTANTIATION = [{ type: "uint24" }, { type: "uint24" }] as const;
const POOL_INITIALIZATION_V4_1 = [
  {
    type: "tuple",
    components: [
      { name: "extension", type: "address" },
      { name: "extensionData", type: "bytes" },
      { name: "feeData", type: "bytes" },
    ],
  },
] as const;
const SNIPER_AUCTION_INIT_V4_1 = [
  {
    type: "tuple",
    components: [
      { name: "startingFee", type: "uint24" },
      { name: "endingFee", type: "uint24" },
      { name: "secondsToDecay", type: "uint256" },
    ],
  },
] as const;

// ── the deploy ───────────────────────────────────────────────────────────────

export type DeployParams = {
  chain: LaunchChain;
  name: string;
  symbol: string;
  image: string;
  description: string | null;
  interface_name: string;
  token_admin: Address;
  salt: Hex;
  pool_preset: PoolPreset;
  clanker_fee_bps: number;
  paired_fee_bps: number;
  rewards: RewardRecipient[];
};

export type DeploymentConfig = {
  tokenConfig: {
    tokenAdmin: Address;
    name: string;
    symbol: string;
    salt: Hex;
    image: string;
    metadata: string;
    context: string;
    originatingChainId: bigint;
  };
  poolConfig: { hook: Address; pairedToken: Address; tickIfToken0IsClanker: number; tickSpacing: number; poolData: Hex };
  lockerConfig: {
    locker: Address;
    rewardAdmins: Address[];
    rewardRecipients: Address[];
    rewardBps: number[];
    tickLower: number[];
    tickUpper: number[];
    positionBps: number[];
    lockerData: Hex;
  };
  mevModuleConfig: { mevModule: Address; mevModuleData: Hex };
  extensionConfigs: { extension: Address; msgValue: bigint; extensionBps: number; extensionData: Hex }[];
};

export type UnsignedDeployTx = {
  chain: LaunchChain;
  chain_id: number;
  to: Address;
  data: Hex;
  /** Wei, as a decimal string. Always "0": no extension that takes ETH is built. */
  value: "0";
};

export function metadataString(description: string | null): string {
  return description ? JSON.stringify({ description }) : "";
}

export function contextString(interfaceName: string): string {
  return JSON.stringify({ interface: interfaceName });
}

/** The `deployToken` argument, built the way clanker-sdk 4.2.19's converter builds it for a static-fee WETH pool. */
export function buildDeploymentConfig(p: DeployParams): DeploymentConfig {
  const c = CLANKER_V4[p.chain];
  const positions = POOL_PRESETS[p.pool_preset];
  const feeData = encodeAbiParameters(STATIC_FEE_INSTANTIATION, [p.clanker_fee_bps * 100, p.paired_fee_bps * 100]);
  const poolData = encodeAbiParameters(POOL_INITIALIZATION_V4_1, [{ extension: zeroAddress, extensionData: "0x", feeData }]);
  const mevModuleData: Hex = c.mev_module_takes_sniper_fees
    ? encodeAbiParameters(SNIPER_AUCTION_INIT_V4_1, [{ startingFee: SNIPER_FEES.startingFee, endingFee: SNIPER_FEES.endingFee, secondsToDecay: BigInt(SNIPER_FEES.secondsToDecay) }])
    : "0x";
  return {
    tokenConfig: {
      tokenAdmin: getAddress(p.token_admin),
      name: p.name,
      symbol: p.symbol,
      salt: p.salt,
      image: p.image,
      metadata: metadataString(p.description),
      context: contextString(p.interface_name),
      originatingChainId: BigInt(c.chain_id),
    },
    poolConfig: { hook: c.static_fee_hook, pairedToken: c.weth, tickIfToken0IsClanker: DEFAULT_START_TICK, tickSpacing: TICK_SPACING, poolData },
    lockerConfig: {
      locker: c.locker,
      rewardAdmins: p.rewards.map((r) => getAddress(r.admin)),
      rewardRecipients: p.rewards.map((r) => getAddress(r.recipient)),
      rewardBps: p.rewards.map((r) => r.bps),
      tickLower: positions.map((x) => x.tickLower),
      tickUpper: positions.map((x) => x.tickUpper),
      positionBps: positions.map((x) => x.positionBps),
      lockerData: encodeAbiParameters(LOCKER_INSTANTIATION, [{ feePreference: p.rewards.map((r) => REWARD_TOKEN_CODES[r.token]) }]),
    },
    mevModuleConfig: { mevModule: c.mev_module, mevModuleData },
    extensionConfigs: [],
  };
}

export function encodeDeploy(cfg: DeploymentConfig): Hex {
  return encodeFunctionData({ abi: DEPLOY_TOKEN_ABI, functionName: "deployToken", args: [cfg] });
}

export function unsignedDeployTx(p: DeployParams): { config: DeploymentConfig; tx: UnsignedDeployTx } {
  const config = buildDeploymentConfig(p);
  const c = CLANKER_V4[p.chain];
  return { config, tx: { chain: p.chain, chain_id: c.chain_id, to: c.factory, data: encodeDeploy(config), value: "0" } };
}

export { zeroHash as DEFAULT_SALT };
