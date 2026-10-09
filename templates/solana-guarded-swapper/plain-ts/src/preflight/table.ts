// Plain-text output for a person. It describes; it never grades. The words
// below are the ones Sato Check uses for its answers.

import { countStatuses, type PreflightReport } from "./check.js";
import type { Receipt, Row } from "./types.js";

export const KEY_ACCESS_WORDS: Record<string, string> = {
  none_found: "no key read found",
  declared: "asks for a key",
  reads: "reads key material",
  unknown: "unknown",
};

export const KEY_EGRESS_WORDS: Record<string, string> = {
  not_observed: "not observed",
  observed: "YES, observed",
  unknown: "not run",
};

export const STATUS_WORDS: Record<Row["status"], string> = {
  same_build: "✓ same build as recorded",
  different_build: "⚠ different build",
  no_receipt: "— no reading for this version",
  lock_mismatch: "⚠ tarball differs from package-lock.json",
  unchecked: "? could not check",
};

export const FOOTER = [
  "A reading describes what Sato Check found in that exact build on that date. It is not a safety rating, an audit or an endorsement.",
  '"Not observed" means no planted test key left the machine during install and start-up under test conditions; code paths that only run later are not covered.',
  '"No reading" means Sato Check holds no record for this version. It does not mean anything is wrong.',
  '"Different build" means the files you installed are not the files the reading was recorded for. Look at the reading for the version you actually run.',
];

const day = (iso: string): string => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : iso);
const short = (h: string): string => `${h.slice(0, 12)}…`;

function cells(r: Row): string[] {
  const id = `${r.subject.name}@${r.subject.version}`;
  const rc: Receipt | null = r.receipt;
  const read = r.status === "no_receipt" || r.status === "unchecked" || !rc;
  return [
    id,
    read ? "—" : day(rc.as_of),
    read ? "—" : KEY_ACCESS_WORDS[rc.key_access] ?? rc.key_access,
    read ? "—" : KEY_EGRESS_WORDS[rc.key_egress] ?? rc.key_egress,
    STATUS_WORDS[r.status],
  ];
}

export const HEAD = ["Package", "Reading", "Key access", "Key leaves?", "This build"];

export function renderTable(report: PreflightReport): string {
  const body = report.rows.map(cells);
  const widths = HEAD.map((h, c) => Math.max(h.length, ...body.map((row) => [...row[c]].length)));
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - [...s].length));
  const line = (row: string[]) => row.map((s, c) => (c === row.length - 1 ? s : pad(s, widths[c]))).join("  ");
  const out: string[] = [line(HEAD), line(widths.map((w) => "-".repeat(w)))];
  for (const row of body) out.push(line(row));
  return out.join("\n");
}

/** One line per row that has something to link or explain. */
export function renderDetails(report: PreflightReport): string {
  const out: string[] = [];
  for (const r of report.rows) {
    const id = `${r.subject.name}@${r.subject.version}`;
    const lines: string[] = [];
    if (r.receipt?.explorer_url) lines.push(`on Solana: ${r.receipt.explorer_url}`);
    if (r.receipt?.reading_url) lines.push(`reading:   ${r.receipt.reading_url}`);
    if (r.status === "different_build" && r.receipt && r.installed_digest_hex) lines.push(`recorded sha256 ${short(r.receipt.digest_hex)}, installed sha256 ${short(r.installed_digest_hex)}`);
    if ((r.status === "unchecked" || r.status === "lock_mismatch") && r.detail) lines.push(r.detail);
    if (lines.length === 0) continue;
    out.push(id, ...lines.map((l) => `  ${l}`));
  }
  return out.join("\n");
}

export function renderSummary(report: PreflightReport): string {
  const c = countStatuses(report.rows);
  const parts = [`${report.rows.length} checked`, `${c.same_build} same build as recorded`, `${c.different_build} different build`, `${c.no_receipt} no reading`];
  if (c.lock_mismatch) parts.push(`${c.lock_mismatch} differ from package-lock.json`);
  if (c.unchecked) parts.push(`${c.unchecked} could not be checked`);
  return parts.join(" · ");
}

export function renderReport(report: PreflightReport): string {
  const details = renderDetails(report);
  return [
    "Sato Check receipts for the packages this agent installs",
    report.source_note,
    "",
    renderTable(report),
    "",
    renderSummary(report),
    ...(details ? ["", details] : []),
    "",
    ...FOOTER,
  ].join("\n");
}
