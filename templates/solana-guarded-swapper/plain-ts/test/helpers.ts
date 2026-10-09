// A generated repo's policy.json carries the caps from the builder's goal, which
// can differ from this template's defaults. The tests that count on specific
// numbers read the template's own defaults (sato.template.json
// template.policy_defaults, laid over policy.json) from a temp file instead, so
// they mean the same thing in the template and in a repo made from it.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function templatePolicyFile(): string {
  const tpl = JSON.parse(readFileSync("sato.template.json", "utf8")) as { template: { policy_defaults: Record<string, unknown> } };
  const policy = { ...JSON.parse(readFileSync("policy.json", "utf8")), ...tpl.template.policy_defaults };
  const file = join(mkdtempSync(join(tmpdir(), "sgs-policy-")), "policy.json");
  writeFileSync(file, JSON.stringify(policy, null, 2));
  return file;
}
