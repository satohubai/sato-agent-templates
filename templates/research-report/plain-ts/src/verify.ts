// The gate between a model's output and this template's output.
//
// A MODEL PROPOSES. THIS DECIDES. Migrated unchanged in behaviour from the Sato
// Hub recipe onchain-research-report (src/verify.mjs). Deterministic: the same
// proposal against the same corpus is accepted or rejected identically.
//
// 1. EVERY CITATION MUST BE A SOURCE WE SUPPLIED. A finding citing an id
//    outside the corpus is REJECTED, with the id named.
// 2. EVERY NUMBER MUST APPEAR IN A CITED SOURCE, as a token in the text of at
//    least one source the finding cites. An onchain read made through the kit
//    is a source like any other: its sentence carries the exact value read.
// 3. AN UNKNOWN IS NOT A FINDING. Different arrays; they never mix.
//
// Nothing here is a quality judgement. It proves a finding is ATTRIBUTABLE,
// which is narrower than true.

export type Source = { id: string; kind: string; url: string; retrieved_at: string; content: string };
export type Finding = { statement: string; source_ids: string[]; confidence: "high" | "medium" | "low" };
export type Rejected = { statement: string; reason: "empty_statement" | "uncited" | "unknown_source" | "unsupported_number"; detail: string };
export type UnknownItem = { question: string; reason: string };
export type Conflict = { topic: string; source_ids: string[]; detail: string };

/** Number-shaped tokens; hex identifiers are stripped first (an address is not an amount). */
const NUMBER_TOKEN = /(?<![\w.])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\w])/g;

function withoutHex(text: string): string {
  return String(text).replace(/0x[0-9a-fA-F]+/g, " ");
}

export function numbersIn(text: string): string[] {
  return [...withoutHex(text).matchAll(NUMBER_TOKEN)].map((m) => m[0].replace(/,/g, ""));
}

export function unsupportedNumbers(statement: string, citedSources: { content?: string }[]): string[] {
  const supported = new Set<string>();
  for (const s of citedSources) for (const n of numbersIn(s.content ?? "")) supported.add(n);
  return numbersIn(statement).filter((n) => !supported.has(n));
}

type Proposal = { findings?: unknown[]; conflicts?: unknown[]; unknowns?: unknown[] };

export function verifyProposal(proposal: Proposal, sources: Source[]): { findings: Finding[]; rejected: Rejected[]; unknowns: UnknownItem[]; conflicts: Conflict[] } {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const findings: Finding[] = [];
  const rejected: Rejected[] = [];

  for (const raw of Array.isArray(proposal.findings) ? proposal.findings : []) {
    const f = (raw ?? {}) as { statement?: unknown; source_ids?: unknown; confidence?: unknown };
    const statement = typeof f.statement === "string" ? f.statement.trim() : "";
    const ids = Array.isArray(f.source_ids) ? f.source_ids.map(String) : [];
    if (!statement) {
      rejected.push({ statement: String(f.statement ?? ""), reason: "empty_statement", detail: "a finding with no statement" });
      continue;
    }
    if (ids.length === 0) {
      rejected.push({ statement, reason: "uncited", detail: "a finding with no source is an assertion, not a finding" });
      continue;
    }
    const unknownIds = ids.filter((id) => !byId.has(id));
    if (unknownIds.length) {
      rejected.push({ statement, reason: "unknown_source", detail: `cites ${unknownIds.join(", ")}, which was never supplied to this run` });
      continue;
    }
    const bad = unsupportedNumbers(statement, ids.map((id) => byId.get(id) as Source));
    if (bad.length) {
      rejected.push({ statement, reason: "unsupported_number", detail: `the value(s) ${bad.join(", ")} do not appear in any cited source` });
      continue;
    }
    findings.push({ statement, source_ids: [...ids].sort(), confidence: f.confidence === "high" || f.confidence === "medium" || f.confidence === "low" ? f.confidence : "low" });
  }

  const unknowns: UnknownItem[] = (Array.isArray(proposal.unknowns) ? proposal.unknowns : [])
    .map((u) => (u ?? {}) as { question?: unknown; reason?: unknown })
    .filter((u) => typeof u.question === "string" && u.question.trim())
    .map((u) => ({ question: (u.question as string).trim(), reason: typeof u.reason === "string" && u.reason.trim() ? u.reason.trim() : "not established by the supplied sources" }));

  const conflicts: Conflict[] = (Array.isArray(proposal.conflicts) ? proposal.conflicts : [])
    .map((c) => (c ?? {}) as { topic?: unknown; source_ids?: unknown; detail?: unknown })
    .filter((c) => typeof c.topic === "string" && Array.isArray(c.source_ids))
    .map((c) => ({
      topic: (c.topic as string).trim(),
      source_ids: (c.source_ids as unknown[]).map(String).filter((id) => byId.has(id)).sort(),
      detail: typeof c.detail === "string" ? c.detail.trim() : "",
    }))
    // A conflict between fewer than two sources we hold is not one we can show.
    .filter((c) => c.source_ids.length >= 2);

  return { findings, rejected, unknowns, conflicts };
}
