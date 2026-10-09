// policy.json: a sato.policy/v1 file, parsed by the kit's own parser.
//
// The kit's pre-flight explains every refusal; enforcement lives in the signer.
// This agent has no signer: it stops at an unsigned transaction, so the file
// below decides whether a swap is prepared at all, and the wallet that signs it
// (yours) decides whether it is sent.
//
// "network" in the file says where this agent is allowed to run:
//   "fork"     the default. Fixture mode only: recorded answers, nothing live.
//   "mainnet"  needed for --mode live. Jupiter quotes and swaps Solana mainnet
//              only, so a live run is a mainnet run. Setting this is the first
//              half of accepting that; --accept-mainnet-risk is the second.
// There is no Solana testnet venue, so "testnet" is refused.

import { readFileSync } from "node:fs";
import { parsePolicyFile, type SatoPolicy } from "@satohub/kit";
import type { Mode } from "./config.js";
import { WSOL_MINT } from "./tokens.js";

export function loadPolicy(path: string, mode: Mode): SatoPolicy {
  const parsed = parsePolicyFile(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.ok) throw new Error(`policy.json: ${parsed.error}`);
  const p = parsed.policy;
  if (p.network === "testnet") throw new Error('policy.json: "network" must be "fork" or "mainnet". Jupiter has no Solana testnet venue, so there is nothing to point a testnet policy at.');
  if (mode === "live" && p.network !== "mainnet") {
    throw new Error('live mode reads Solana mainnet, and policy.json says "network": "fork". Change it to "mainnet" yourself (that edit, with --accept-mainnet-risk, is your acceptance), or run --mode fixture.');
  }
  if (p.max_usd_per_day === null) throw new Error('policy.json: this template needs a daily cap. Set "max_usd_per_day" to a number.');
  if (p.max_usd_per_trade === null) throw new Error('policy.json: this template needs a per-swap cap. Set "max_usd_per_trade" to a number.');
  if (p.unknown_verdict !== "refuse") throw new Error('policy.json: "unknown_verdict" must stay "refuse": a value the kit cannot read must refuse, never read as fine.');
  if (!p.allow_chains.includes("solana") || !p.allow_tokens.includes(`solana:${WSOL_MINT}`)) {
    throw new Error(`policy.json: allow_chains must include "solana" and allow_tokens must include "solana:${WSOL_MINT}" (the SOL this agent sells).`);
  }
  return p;
}

/**
 * The policy the kit evaluates. Every intent here targets mainnet (that is where
 * Jupiter is), so the kit is told "mainnet". In fixture mode that is a replay of
 * recorded answers with no signer and no live call, which is why a policy file
 * that says "fork" is enough to run it.
 */
export function kitPolicy(p: SatoPolicy): SatoPolicy {
  return { ...p, network: "mainnet" };
}
