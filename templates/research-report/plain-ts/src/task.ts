// Onchain research report, as a function of (input, model adapter, chain reads).
//
// Migrated from the Sato Hub recipe onchain-research-report (src/task.mjs). The
// model is handed a CLOSED corpus — the supplied sources plus one sentence per
// onchain read made through the kit — and returns a candidate. The candidate
// goes through src/verify.ts before any of it becomes output.
//
// `sources_used` is derived from the findings that SURVIVED, never from what
// the model claimed to use.

import type { ChainReadRecord } from "./chain.js";
import type { ModelAdapter } from "./providers.js";
import { verifyProposal, type Conflict, type Finding, type Rejected, type Source, type UnknownItem } from "./verify.js";

export const OUTPUT_SCHEMA_ID = "sato.template.research-report.output/v1";

export type ReportInput = {
  now?: string;
  question: string;
  sources?: Source[];
  chain_reads?: import("./chain.js").ChainReadRequest[];
};

export type ReportOutput = {
  schema: typeof OUTPUT_SCHEMA_ID;
  generated_at: string;
  question: string;
  provider: string;
  source_kind: "fixture" | "fork" | "rpc";
  findings: Finding[];
  conflicts: Conflict[];
  rejected: Rejected[];
  unknowns: UnknownItem[];
  chain_reads: ChainReadRecord[];
  sources_supplied: string[];
  sources_used: string[];
};

export const SYSTEM = [
  "You are answering strictly from the numbered sources supplied in the prompt.",
  "Cite the id of every source a statement rests on.",
  "If a number is not written in a source, do not write it.",
  "Put anything the sources do not establish in `unknowns`, never in `findings`.",
  "Answer with JSON only: {findings:[{statement,source_ids,confidence}],conflicts:[{topic,source_ids,detail}],unknowns:[{question,reason}]}.",
].join("\n");

export function buildPrompt(question: string, sources: Source[]): string {
  const corpus = sources.map((s) => `[${s.id}] (${s.kind}, retrieved ${s.retrieved_at})\n${s.content}`).join("\n\n");
  return `Question: ${question}\n\nSources:\n${corpus}`;
}

export async function runTask(
  input: ReportInput,
  adapter: ModelAdapter,
  chain: { sources: Source[]; unknowns: UnknownItem[]; records: ChainReadRecord[] },
  ctx: { now: string; source_kind: ReportOutput["source_kind"] },
): Promise<ReportOutput> {
  const sources = [...(input.sources ?? []), ...chain.sources];
  let proposal: Record<string, unknown> = { findings: [], conflicts: [], unknowns: [] };
  let modelError: string | null = null;
  try {
    const completion = await adapter.complete({ system: SYSTEM, prompt: buildPrompt(input.question, sources), max_tokens: 4000, temperature: 0 });
    // A model's reply is untrusted text. Unparseable is a recorded failure, not a crash and not an empty success.
    const parsed: unknown = JSON.parse(completion.text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("the model's reply is not a JSON object");
    proposal = parsed as Record<string, unknown>;
  } catch (e) {
    modelError = String((e as Error)?.message ?? e).slice(0, 300);
  }

  const checked = verifyProposal(proposal, sources);
  const used = new Set(checked.findings.flatMap((f) => f.source_ids));
  return {
    schema: OUTPUT_SCHEMA_ID,
    generated_at: input.now ?? ctx.now,
    question: input.question,
    provider: adapter.provider,
    source_kind: ctx.source_kind,
    findings: checked.findings,
    conflicts: checked.conflicts,
    rejected: checked.rejected,
    unknowns: [...(modelError ? [{ question: input.question, reason: modelError }] : []), ...chain.unknowns, ...checked.unknowns],
    chain_reads: chain.records,
    sources_supplied: sources.map((s) => s.id).sort(),
    sources_used: [...used].sort(),
  };
}
