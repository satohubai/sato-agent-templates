// The fallback source: Sato Hub's read API for the same receipts.
//
//   GET <api_url>?id=<subject_id>&version=<version>
//
// Used only when the credential and schema addresses in receipts.config.json
// are not set yet, or the chain read failed. It is one call to a Sato Hub
// server, so it is the weaker of the two sources: the preflight says which one
// it used. The answer is parsed defensively: a receipt object, or { receipt },
// or a 404 / null for "no reading".

import { digestToHex, explorerUrl } from "./sas.js";
import type { Cluster, Fetch, Receipt } from "./types.js";
import { USER_AGENT } from "./tarball.js";

export type ApiResult = { ok: true; receipt: Receipt | null } | { ok: false; error: string };

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Accepts the contract's SolanaReceipt shape (digest_hex) or a bare `digest`. Returns null when it is not a receipt. */
export function parseReceipt(body: unknown): Receipt | null {
  if (body === null || typeof body !== "object") return null;
  const o = (body as { receipt?: unknown }).receipt !== undefined ? (body as { receipt: unknown }).receipt : body;
  if (o === null || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  const digest = r.digest_hex ?? r.digest;
  const subject_id = str(r.subject_id);
  const version = str(r.version);
  if (!subject_id || !version || digest === undefined) return null;
  let digest_hex: string;
  try {
    digest_hex = digestToHex(digest);
  } catch {
    return null;
  }
  const cluster: Cluster | null = r.cluster === "devnet" || r.cluster === "mainnet-beta" ? r.cluster : null;
  const address = str(r.attestation_address);
  const fa = r.fund_action_count;
  return {
    subject_kind: str(r.subject_kind) ?? "package",
    subject_id,
    version,
    digest_hex,
    key_access: str(r.key_access) ?? "unknown",
    key_egress: str(r.key_egress) ?? "unknown",
    fund_action_count: typeof fa === "number" && fa >= 0 ? fa : null,
    method_version: str(r.method_version) ?? "unknown",
    as_of: str(r.as_of) ?? "unknown",
    reading_url: str(r.reading_url) ?? "",
    attestation_address: address,
    cluster,
    explorer_url: str(r.explorer_url) ?? (address && cluster ? explorerUrl(address, cluster) : null),
  };
}

export async function readReceiptFromApi(fetchImpl: Fetch, apiUrl: string, subjectId: string, version: string, timeoutMs = 15_000): Promise<ApiResult> {
  try {
    const u = new URL(apiUrl);
    u.searchParams.set("id", subjectId);
    u.searchParams.set("version", version);
    const res = await fetchImpl(u, { headers: { "user-agent": USER_AGENT, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 404) {
      // A JSON 404 is the API saying "no reading". An HTML 404 is the route not being there; that is not a "no".
      if ((res.headers.get("content-type") ?? "").includes("json")) return { ok: true, receipt: null };
      return { ok: false, error: `${u.host} has no receipt API at that address yet (HTTP 404, not JSON)` };
    }
    if (!res.ok) return { ok: false, error: `${u.host} answered HTTP ${res.status}` };
    const body: unknown = await res.json();
    const receipt = parseReceipt(body);
    if (receipt === null && body !== null && typeof body === "object") {
      const inner = (body as { receipt?: unknown }).receipt;
      // { receipt: null } is a clean "no reading"; anything else we cannot read is an error, not a "no".
      if (inner === null) return { ok: true, receipt: null };
      return { ok: false, error: "the API answered with a body that is not a receipt" };
    }
    if (receipt && (receipt.subject_id !== subjectId || receipt.version !== version)) return { ok: false, error: "the API answered for a different subject or version" };
    return { ok: true, receipt };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
