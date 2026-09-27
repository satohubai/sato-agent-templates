// Plain-text lines for a person, and the structured report written to out/.

import type { PreparedIntent, Refusal } from "@satohub/kit";

export function line(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(20)} ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

/** The one line a refusal prints. Tests grep for exactly this shape. */
export function refusalLine(r: Refusal): string {
  return `REFUSED rule=${r.rule} limit=${r.limit} observed=${r.observed} — ${r.message}`;
}

export type IntentReport = {
  label: string;
  demo_refusal: boolean;
  intent_id: string;
  action: string;
  summary: string;
  expires_at: string;
  policy_ok: boolean;
  refusals: Refusal[];
  simulation: PreparedIntent["simulation"];
  fee_disclosure: PreparedIntent["fee_disclosure"];
  unsigned: { kind: string; to?: string; value?: string; data_bytes?: number };
};

export function intentReport(label: string, demo: boolean, p: PreparedIntent): IntentReport {
  const u = p.unsigned;
  return {
    label,
    demo_refusal: demo,
    intent_id: p.intent_id,
    action: p.action,
    summary: p.summary,
    expires_at: p.expires_at,
    policy_ok: p.policy.ok,
    refusals: p.policy.refusals,
    simulation: p.simulation,
    fee_disclosure: p.fee_disclosure,
    unsigned: u.kind === "evm_tx" ? { kind: u.kind, to: u.to, value: u.value, data_bytes: (u.data.length - 2) / 2 } : { kind: u.kind },
  };
}

export function printPrepared(p: PreparedIntent): void {
  line("intent", p.intent_id);
  line("summary", p.summary);
  line("expires", p.expires_at);
  if (p.simulation) {
    line("simulation", `${p.simulation.ok ? "ok" : "failed"} via ${p.simulation.method} at block ${p.simulation.block ?? "n/a"}${p.simulation.gas_estimate ? `, gas ${p.simulation.gas_estimate}` : ""}${p.simulation.error ? ` — ${p.simulation.error}` : ""}`);
  } else line("simulation", "not run (the pre-flight refused first)");
  const u = p.unsigned;
  if (u.kind === "evm_tx") line("unsigned tx", `to ${u.to}, value ${u.value} wei, ${(u.data.length - 2) / 2} bytes of calldata, chain ${u.chain_id}`);
  if (p.policy.ok) line("pre-flight", "passed — within policy.json");
  else for (const r of p.policy.refusals) console.log(`  ${refusalLine(r)}`);
}
