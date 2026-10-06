// policy.json: a sato.policy/v1 file, parsed by the kit's own parser.
//
// This template prepares an unsigned transaction and holds no signer, so no
// intent ever reaches the kit's pre-flight and nothing is enforced here. The
// file is here so that anything added later starts from a refusing default:
// human approval on, simulation required, 1 USD caps, unknown refuses. The
// kit's pre-flight explains refusals; enforcement lives in a signer, and this
// template has none.

import { readFileSync } from "node:fs";
import { parsePolicyFile, type SatoPolicy } from "@satohub/kit";

export function loadPolicy(path: string): SatoPolicy {
  const parsed = parsePolicyFile(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.ok) throw new Error(`policy.json: ${parsed.error}`);
  if (parsed.policy.network === "mainnet") throw new Error("policy.json: this template does not run on mainnet; it simulates on a fork or testnet and you sign yourself");
  return parsed.policy;
}
