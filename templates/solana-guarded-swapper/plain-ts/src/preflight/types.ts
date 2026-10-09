// Shapes shared by the preflight modules.
//
// A receipt is a dated Sato Check reading of one exact build of an npm package,
// recorded as a Solana Attestation Service (SAS) attestation. It DESCRIBES what
// the package does with keys. It is not a safety grade and nothing here says so.

export type Cluster = "mainnet-beta" | "devnet";

/** A decoded receipt, the same fields whichever source it came from. */
export type Receipt = {
  subject_kind: string;
  subject_id: string;
  version: string;
  /** sha256 of the npm tarball, lower-case hex, 64 characters, no 0x. */
  digest_hex: string;
  /** Sato Check's key_access value: none_found | declared | reads | unknown. */
  key_access: string;
  /** Sato Check's key_egress value: not_observed | observed | unknown. */
  key_egress: string;
  /** null when stored as -1 (unknown). */
  fund_action_count: number | null;
  method_version: string;
  /** ISO date of the reading. */
  as_of: string;
  reading_url: string;
  /** Present when the receipt was read from chain; the API may also supply it. */
  attestation_address: string | null;
  cluster: Cluster | null;
  explorer_url: string | null;
};

export type ReceiptSource = "chain" | "api";

export type ReceiptLookup =
  | { found: true; receipt: Receipt; source: ReceiptSource }
  | { found: false; source: ReceiptSource }
  | { found: "error"; source: ReceiptSource; error: string };

/** One locked package the preflight looks at. */
export type Subject = {
  name: string;
  version: string;
  /** npm:<name>, the id a receipt is filed under. */
  subject_id: string;
  /** Why it is checked: a direct dependency, on the watch list, or --all. */
  reason: "direct" | "watch" | "all";
  resolved: string | null;
  integrity: string | null;
  /** lock path, e.g. node_modules/@satohub/kit */
  lock_path: string;
};

export type DigestResult =
  | { ok: true; digest_hex: string; origin: "registry" | "vendored"; lock_integrity: "match" | "not_in_lock" }
  | { ok: false; reason: "lock_mismatch" | "unreachable"; detail: string };

export type BuildStatus = "same_build" | "different_build" | "no_receipt" | "lock_mismatch" | "unchecked";

export type Row = {
  subject: Subject;
  status: BuildStatus;
  /** Why a row is unchecked, or the detail of a lock mismatch. */
  detail: string | null;
  installed_digest_hex: string | null;
  receipt: Receipt | null;
  source: ReceiptSource | null;
};

export type Fetch = typeof fetch;

/** One JSON-RPC call. Injected so tests never touch the network. */
export type JsonRpc = (method: string, params: unknown[]) => Promise<unknown>;
