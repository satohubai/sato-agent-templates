// The reward split written into the deploy (Clanker v4 `rewards.recipients`).
//
// ONE RECIPIENT: the creator. The creator's address is the recipient AND the
// admin of the reward position, with all 10000 bps. This template adds no
// other recipient: no template author, no Sato Hub address, no referrer. The
// split is checked to total exactly 10000 bps before anything is encoded.
//
// Clanker's own protocol share of LP fees is taken by Clanker's contracts and
// is not part of this list; see the README.

import { getAddress, isAddress, zeroAddress, type Address } from "viem";

export const BPS_TOTAL = 10000;

/** Which side of the pool fees a recipient takes. Codes are clanker-sdk 4.2.19 FeeInToInt. */
export const REWARD_TOKEN_CODES = { Both: 0, Paired: 1, Clanker: 2 } as const;
export type RewardToken = keyof typeof REWARD_TOKEN_CODES;

export type RewardRecipient = { recipient: Address; admin: Address; bps: number; token: RewardToken };

export class RewardSplitError extends Error {}

/** The split this template writes: the creator, 10000 bps, as recipient and admin. */
export function creatorRewards(creator: string, token: RewardToken = "Both"): RewardRecipient[] {
  if (!isAddress(creator, { strict: false }) || getAddress(creator) === zeroAddress) throw new RewardSplitError("the creator must be a non-zero EVM address");
  const a = getAddress(creator);
  const split: RewardRecipient[] = [{ recipient: a, admin: a, bps: BPS_TOTAL, token }];
  assertSplit(split, a);
  return split;
}

/**
 * Refuses a split that does not total exactly 10000 bps, has a negative or
 * fractional share, or names anyone but the creator.
 */
export function assertSplit(split: readonly RewardRecipient[], creator: Address): void {
  if (split.length === 0) throw new RewardSplitError("the reward split is empty");
  let total = 0;
  for (const r of split) {
    if (!Number.isInteger(r.bps) || r.bps < 0 || r.bps > BPS_TOTAL) throw new RewardSplitError(`reward bps ${r.bps} is not an integer between 0 and ${BPS_TOTAL}`);
    if (!(r.token in REWARD_TOKEN_CODES)) throw new RewardSplitError(`reward token ${String(r.token)} is not Both, Paired or Clanker`);
    if (getAddress(r.recipient) !== getAddress(creator) || getAddress(r.admin) !== getAddress(creator))
      throw new RewardSplitError(`reward recipient ${r.recipient} (admin ${r.admin}) is not the creator; this template writes the creator as the only recipient`);
    total += r.bps;
  }
  if (total !== BPS_TOTAL) throw new RewardSplitError(`the reward split totals ${total} bps, not ${BPS_TOTAL}`);
}
