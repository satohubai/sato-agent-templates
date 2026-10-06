// One launch preparation:
//   validated input -> the creator-only reward split -> the unsigned
//   Clanker v4 deployToken call -> decode it back (the summary is read from
//   the calldata, not from the input) -> simulate it through the kit's
//   tx.simulate -> report.
//
// Nothing here signs or sends. The report says so in two boolean fields that
// are always false, and the schema (schemas/output.json) only accepts false.

import { BaseError, decodeErrorResult, decodeFunctionData, decodeFunctionResult, type Address, type Hex, type PublicClient } from "viem";
import type { Kit } from "@satohub/kit";
import {
  CLANKER_ERRORS_ABI,
  CLANKER_SOURCES,
  CLANKER_V4,
  DEPLOY_TOKEN_ABI,
  SNIPER_FEES,
  TOKEN_DECIMALS,
  TOKEN_SUPPLY_BASE_UNITS,
  unsignedDeployTx,
  type DeploymentConfig,
  type LaunchChain,
  type PoolPreset,
  type UnsignedDeployTx,
} from "./clanker.js";
import type { LaunchInput } from "./config.js";
import { assertSplit, BPS_TOTAL, creatorRewards, REWARD_TOKEN_CODES, type RewardToken } from "./rewards.js";
import { ACTIONS, type TxSimulateInput, type TxSimulateOutput } from "./kit-io.js";
import { TEMPLATE_ID, TEMPLATE_VERSION } from "./runtime.js";

export const LAUNCH_CAVEAT =
  "Launching a token is a real onchain action with real costs. Signing this transaction creates a token contract and a Uniswap v4 pool that anyone can trade, and you pay the gas. This repository prepared and simulated the transaction; it did not sign or send it, and it holds no key. You sign it with your own wallet and you are responsible for it. A passing simulation means the call did not revert at the simulated block; it is not a security review, an audit, a price forecast or a statement about what the token will do after it launches. Nothing here is investment advice.";

export type SimulationView = TxSimulateOutput & {
  simulated_from: Address;
  /** The address deployToken returned in the simulation, or null when it did not run or could not be read. */
  predicted_token_address: Address | null;
  /** The factory's custom error name when a revert decoded to one, else null. */
  revert_name: string | null;
  note: string;
};

export type LaunchReport = {
  template: typeof TEMPLATE_ID;
  template_version: typeof TEMPLATE_VERSION;
  generated_at: string;
  source_kind: "fixture" | "fork" | "rpc";
  signed: false;
  broadcast: false;
  unsigned_tx: UnsignedDeployTx & { from: Address };
  summary: {
    venue: "Clanker v4";
    function: "deployToken";
    chain: LaunchChain;
    chain_id: number;
    factory: Address;
    token: {
      name: string;
      symbol: string;
      image: string;
      metadata: string;
      context: string;
      decimals: number;
      total_supply_base_units: string;
      admin: Address;
      salt: Hex;
    };
    rewards: { recipients: { recipient: Address; admin: Address; bps: number; token: RewardToken }[]; total_bps: number };
    pool: {
      paired_token: Address;
      paired_token_symbol: "WETH";
      hook: Address;
      start_tick: number;
      tick_spacing: number;
      preset: PoolPreset;
      positions: { tick_lower: number; tick_upper: number; position_bps: number }[];
      fee: { type: "static"; clanker_fee_bps: number; paired_fee_bps: number };
    };
    locker: Address;
    fee_locker: Address;
    mev_module: Address;
    sniper_fee: { starting_fee_unibps: number; ending_fee_unibps: number; seconds_to_decay: number } | null;
    extensions: never[];
    value_wei: "0";
    lines: string[];
  };
  simulation: SimulationView;
  next_steps: string[];
  caveat: string;
  sources: { fact: string; url: string }[];
};

/** The placeholder creator in config.json. */
export const EXAMPLE_CREATOR = "0x000000000000000000000000000000000000dEaD";

const TOKEN_BY_CODE = Object.fromEntries(Object.entries(REWARD_TOKEN_CODES).map(([k, v]) => [v, k])) as Record<number, RewardToken>;

/** Decode the calldata back into the deployment config, so the summary describes the bytes you will sign. */
export function decodeDeploy(data: Hex): DeploymentConfig {
  const d = decodeFunctionData({ abi: DEPLOY_TOKEN_ABI, data });
  if (d.functionName !== "deployToken") throw new Error(`calldata is ${d.functionName}, not deployToken`);
  const cfg = d.args[0];
  return {
    tokenConfig: { ...cfg.tokenConfig },
    poolConfig: { ...cfg.poolConfig },
    lockerConfig: {
      ...cfg.lockerConfig,
      rewardAdmins: [...cfg.lockerConfig.rewardAdmins],
      rewardRecipients: [...cfg.lockerConfig.rewardRecipients],
      rewardBps: [...cfg.lockerConfig.rewardBps],
      tickLower: [...cfg.lockerConfig.tickLower],
      tickUpper: [...cfg.lockerConfig.tickUpper],
      positionBps: [...cfg.lockerConfig.positionBps],
    },
    mevModuleConfig: { ...cfg.mevModuleConfig },
    extensionConfigs: cfg.extensionConfigs.map((e) => ({ ...e })),
  };
}

/** Reads the reward token preferences back out of lockerData. */
function feePreferences(cfg: DeploymentConfig): RewardToken[] {
  // lockerData = abi.encode((uint8[] feePreference)); decode via the same ABI shape.
  const d = decodeFunctionResult({
    abi: [{ type: "function", name: "x", inputs: [], outputs: [{ type: "tuple", components: [{ type: "uint8[]", name: "feePreference" }] }], stateMutability: "view" }] as const,
    functionName: "x",
    data: cfg.lockerConfig.lockerData,
  });
  return d.feePreference.map((c) => TOKEN_BY_CODE[c] ?? (`unknown(${c})` as RewardToken));
}

function revertNameOf(e: unknown): string | null {
  if (!(e instanceof BaseError)) return null;
  let data: Hex | undefined;
  e.walk((x) => {
    const d = (x as { data?: unknown }).data;
    if (typeof d === "string" && /^0x[0-9a-fA-F]{8,}$/.test(d)) data = d as Hex;
    return false;
  });
  if (!data) return null;
  try {
    return decodeErrorResult({ abi: CLANKER_ERRORS_ABI, data }).errorName;
  } catch {
    return null;
  }
}

/** tx.simulate through the kit, then one read-only eth_call at the same block for deployToken's return value. */
export async function simulateDeploy(kit: Kit, client: PublicClient, tx: UnsignedDeployTx, from: Address): Promise<SimulationView> {
  const input: TxSimulateInput = { chain: tx.chain, from, to: tx.to, data: tx.data, value: tx.value };
  const sim = await kit.read<TxSimulateOutput>(ACTIONS.txSimulate, input);
  if (!sim.ok) {
    let revert_name: string | null = null;
    if (sim.error?.startsWith("reverted")) {
      try {
        await client.call({ account: from, to: tx.to, data: tx.data, ...(sim.block ? { blockNumber: BigInt(sim.block) } : {}) });
      } catch (e) {
        revert_name = revertNameOf(e);
      }
    }
    return {
      ...sim,
      simulated_from: from,
      predicted_token_address: null,
      revert_name,
      note: "The simulation did not pass. Do not sign this transaction; read the error, change the input, and run again.",
    };
  }
  let predicted: Address | null = null;
  let note = "";
  try {
    const r = await client.call({ account: from, to: tx.to, data: tx.data, ...(sim.block ? { blockNumber: BigInt(sim.block) } : {}) });
    predicted = r.data ? decodeFunctionResult({ abi: DEPLOY_TOKEN_ABI, functionName: "deployToken", data: r.data }) : null;
  } catch (e) {
    note = ` The return value could not be read (${(e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 160)}).`;
  }
  return {
    ...sim,
    simulated_from: from,
    predicted_token_address: predicted,
    revert_name: null,
    note:
      `The call did not revert at block ${sim.block} when run as ${from}.` +
      (predicted
        ? ` The factory returned ${predicted} as the token address. That address holds only if this exact call (same name, symbol, admin, image, metadata, context and salt) has not been deployed by anyone first.`
        : "") +
      note +
      " State changes between this block and the block your transaction lands in; a later run can differ.",
  };
}

export function summarize(input: LaunchInput, tx: UnsignedDeployTx): LaunchReport["summary"] {
  const cfg = decodeDeploy(tx.data);
  const c = CLANKER_V4[input.chain];
  const prefs = feePreferences(cfg);
  const recipients = cfg.lockerConfig.rewardRecipients.map((recipient, i) => ({
    recipient,
    admin: cfg.lockerConfig.rewardAdmins[i],
    bps: cfg.lockerConfig.rewardBps[i],
    token: prefs[i],
  }));
  // The decoded bytes must carry exactly the split this template writes.
  assertSplit(recipients, input.creator);
  const total_bps = recipients.reduce((a, r) => a + r.bps, 0);
  const positions = cfg.lockerConfig.tickLower.map((tl, i) => ({ tick_lower: tl, tick_upper: cfg.lockerConfig.tickUpper[i], position_bps: cfg.lockerConfig.positionBps[i] }));
  const sniper = c.mev_module_takes_sniper_fees
    ? { starting_fee_unibps: SNIPER_FEES.startingFee, ending_fee_unibps: SNIPER_FEES.endingFee, seconds_to_decay: SNIPER_FEES.secondsToDecay }
    : null;
  const t = cfg.tokenConfig;
  const lines = [
    `Calls deployToken on the Clanker v4 factory ${tx.to} on ${input.chain} (chain id ${tx.chain_id}), sending 0 ETH.`,
    `Creates the token "${t.name}" (${t.symbol}), ${TOKEN_DECIMALS} decimals, total supply ${TOKEN_SUPPLY_BASE_UNITS} base units (100,000,000,000 tokens), admin ${t.tokenAdmin}.`,
    `Image: ${t.image || "(none)"}. Metadata: ${t.metadata || "(none)"}. Context: ${t.context}.`,
    `Pairs it with WETH ${cfg.poolConfig.pairedToken} in a Uniswap v4 pool through the static-fee hook ${cfg.poolConfig.hook}: ${input.clanker_fee_bps} bps on the token side and ${input.paired_fee_bps} bps on the WETH side, starting at tick ${cfg.poolConfig.tickIfToken0IsClanker}, tick spacing ${cfg.poolConfig.tickSpacing}.`,
    `Places the supply in ${positions.length} liquidity position(s) held by the locker ${cfg.lockerConfig.locker} (preset ${input.pool_preset}).`,
    `Reward split (${total_bps} bps): ${recipients.map((r) => `${r.recipient} ${r.bps} bps in ${r.token}, admin ${r.admin}`).join("; ")}. No other recipient is written.`,
    sniper
      ? `MEV module ${cfg.mevModuleConfig.mevModule} with a sniper fee starting at ${sniper.starting_fee_unibps} and ending at ${sniper.ending_fee_unibps} hundredths of a bip over ${sniper.seconds_to_decay} seconds (clanker-sdk defaults).`
      : `MEV module ${cfg.mevModuleConfig.mevModule}, no init data (as clanker-sdk builds it on this chain).`,
    "No dev buy, vault, airdrop or presale extension.",
  ];
  if (input.creator === EXAMPLE_CREATOR)
    lines.push(`The creator is ${EXAMPLE_CREATOR}, the example address in config.json: nobody holds its key, so its rewards and the token admin role could never be used. Set creator to your own address.`);
  return {
    venue: "Clanker v4",
    function: "deployToken",
    chain: input.chain,
    chain_id: tx.chain_id,
    factory: tx.to,
    token: {
      name: t.name,
      symbol: t.symbol,
      image: t.image,
      metadata: t.metadata,
      context: t.context,
      decimals: TOKEN_DECIMALS,
      total_supply_base_units: TOKEN_SUPPLY_BASE_UNITS,
      admin: t.tokenAdmin,
      salt: t.salt,
    },
    rewards: { recipients, total_bps },
    pool: {
      paired_token: cfg.poolConfig.pairedToken,
      paired_token_symbol: "WETH",
      hook: cfg.poolConfig.hook,
      start_tick: cfg.poolConfig.tickIfToken0IsClanker,
      tick_spacing: cfg.poolConfig.tickSpacing,
      preset: input.pool_preset,
      positions,
      fee: { type: "static", clanker_fee_bps: input.clanker_fee_bps, paired_fee_bps: input.paired_fee_bps },
    },
    locker: cfg.lockerConfig.locker,
    fee_locker: c.fee_locker,
    mev_module: cfg.mevModuleConfig.mevModule,
    sniper_fee: sniper,
    extensions: [],
    value_wei: "0",
    lines,
  };
}

/** Build, decode, simulate and report one launch. Never signs, never sends. */
export async function prepareLaunch(input: LaunchInput, rt: { kit: Kit; client: PublicClient; chain: LaunchChain; mode: LaunchReport["source_kind"]; clock: () => number }): Promise<LaunchReport> {
  if (input.chain !== rt.chain) throw new Error(`the input asks for ${input.chain}, but this run's RPC answers ${rt.chain}; use an RPC for ${input.chain}`);
  const rewards = creatorRewards(input.creator, input.reward_token);
  if (rewards.reduce((a, r) => a + r.bps, 0) !== BPS_TOTAL) throw new Error("reward split does not total 10000 bps");
  const { tx } = unsignedDeployTx({
    chain: input.chain,
    name: input.name,
    symbol: input.symbol,
    image: input.image,
    description: input.description,
    interface_name: input.interface_name,
    token_admin: input.creator,
    salt: input.salt,
    pool_preset: input.pool_preset,
    clanker_fee_bps: input.clanker_fee_bps,
    paired_fee_bps: input.paired_fee_bps,
    rewards,
  });
  const summary = summarize(input, tx);
  const simulation = await simulateDeploy(rt.kit, rt.client, tx, input.sender);
  return {
    template: TEMPLATE_ID,
    template_version: TEMPLATE_VERSION,
    generated_at: new Date(rt.clock()).toISOString(),
    source_kind: rt.mode,
    signed: false,
    broadcast: false,
    unsigned_tx: { ...tx, from: input.sender },
    summary,
    simulation,
    next_steps: simulation.ok
      ? [
          "Read summary.lines and check every address against the sources below.",
          `Sign unsigned_tx (to, data, value 0, chain id ${tx.chain_id}) from ${input.sender} in your own wallet, if you choose to launch.`,
          "Simulate again right before you sign if time has passed: chain state moves.",
        ]
      : ["Do not sign this transaction: the simulation did not pass. Fix the input named by the error and run again."],
    caveat: LAUNCH_CAVEAT,
    sources: CLANKER_SOURCES.map((s) => ({ ...s })),
  };
}
