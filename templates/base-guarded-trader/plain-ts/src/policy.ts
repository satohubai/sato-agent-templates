// policy.json: a sato.policy/v1 file, parsed by the kit's own parser.
//
// The kit's pre-flight explains every refusal; enforcement lives in the signer.
// This process can edit this file, so it is not a control on its own; on
// testnet the same file is compiled into the managed wallet's native policy.

import { readFileSync } from "node:fs";
import { parsePolicyFile, type SatoPolicy } from "@satohub/kit";

export function loadPolicy(path: string): SatoPolicy {
  const parsed = parsePolicyFile(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.ok) throw new Error(`policy.json: ${parsed.error}`);
  if (parsed.policy.network === "mainnet") throw new Error("policy.json: this template does not run on mainnet");
  return parsed.policy;
}
