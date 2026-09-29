// After a facilitator reports a settlement, the seller confirms it on-chain
// through the Sato Kit's chain.read: the token's ERC-3009 authorizationState
// for (payer, nonce) must now be true. A settlement the chain does not confirm
// is reported as unconfirmed, never as paid-and-confirmed.

import type { Kit } from "@satohub/kit";
import { ACTIONS, AUTHORIZATION_STATE_FRAGMENT, type ChainName, type ChainReadOutput } from "./kit-io.js";

export type Confirmation =
  | { status: "confirmed"; method: "erc3009.authorizationState"; chain: ChainName; block_number: string }
  | { status: "unconfirmed"; method: "erc3009.authorizationState"; chain: ChainName; block_number: string | null; reason: string };

export async function confirmSettlement(kit: Kit, chain: ChainName, asset: string, payer: string, nonce: string): Promise<Confirmation> {
  try {
    const out = await kit.read<ChainReadOutput<boolean>>(ACTIONS.chainRead, { kind: "contract_read", chain, contract: asset, abi: AUTHORIZATION_STATE_FRAGMENT, args: [payer, nonce] });
    if (out.result === true) return { status: "confirmed", method: "erc3009.authorizationState", chain, block_number: out.block_number };
    return { status: "unconfirmed", method: "erc3009.authorizationState", chain, block_number: out.block_number, reason: "the token does not report this authorization as used" };
  } catch (e) {
    return { status: "unconfirmed", method: "erc3009.authorizationState", chain, block_number: null, reason: `chain.read failed: ${(e as Error).message.split("\n")[0]}` };
  }
}
