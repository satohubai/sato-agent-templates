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
  /** A deliberate cap check, not the agent's own trade. Never written out for signing. */
  demo_refusal: boolean;
  intent_id: string;
  action: string;
  summary: string;
  expires_at: string;
  policy_ok: boolean;
  refusals: Refusal[];
  simulation: PreparedIntent["simulation"];
  fee_disclosure: PreparedIntent["fee_disclosure"];
  unsigned: { kind: string; chain?: string; fee_payer?: string; transaction_bytes?: number; last_valid_block_height?: number };
  /** The file holding the unsigned transaction, when one was written. */
  handoff_file: string | null;
};

export function intentReport(label: string, demo: boolean, p: PreparedIntent, handoff_file: string | null): IntentReport {
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
    unsigned:
      u.kind === "solana_tx"
        ? { kind: u.kind, chain: u.chain, fee_payer: u.fee_payer, transaction_bytes: Buffer.from(u.transaction_base64, "base64").length, last_valid_block_height: u.last_valid_block_height }
        : { kind: u.kind },
    handoff_file,
  };
}

export function printPrepared(p: PreparedIntent): void {
  line("intent", p.intent_id);
  line("summary", p.summary);
  line("expires", p.expires_at);
  if (p.simulation) {
    line("simulation", `${p.simulation.ok ? "ok" : "failed"} via ${p.simulation.method} at slot ${p.simulation.block ?? "n/a"}${p.simulation.gas_estimate ? `, ${p.simulation.gas_estimate} compute units` : ""}${p.simulation.error ? ` — ${p.simulation.error}` : ""}`);
  } else line("simulation", "not run");
  const u = p.unsigned;
  if (u.kind === "solana_tx") line("unsigned tx", `${Buffer.from(u.transaction_base64, "base64").length} bytes, fee payer ${u.fee_payer}, valid until block height ${u.last_valid_block_height}`);
  if (p.policy.ok) line("pre-flight", "within policy.json");
  else for (const r of p.policy.refusals) console.log(`  ${refusalLine(r)}`);
}
