// Reads Sato Check receipts straight from Solana, with no key and no call to
// Sato Hub.
//
// A receipt is one Solana Attestation Service (SAS) attestation per (npm
// package, version). Anyone can derive where it lives:
//
//   nonce   = sha256(`${subject_id}@${version}`), read as a 32-byte public key
//   address = PDA of the SAS program at seeds
//             ["attestation", credential, schema, nonce]
//
// The credential and schema addresses come from receipts.config.json. The
// attestation's data blob is laid out by the schema account on chain, so this
// reader fetches the schema too and decodes by its field names and types
// instead of assuming a fixed order. Account layouts follow the SAS program
// (solana-foundation/solana-attestation-service, MIT).

import { createHash } from "node:crypto";
import {
  addDecoderSizePrefix,
  getAddressDecoder,
  getAddressEncoder,
  getArrayDecoder,
  getBase16Decoder,
  getBooleanDecoder,
  getBytesDecoder,
  getI128Decoder,
  getI16Decoder,
  getI32Decoder,
  getI64Decoder,
  getI8Decoder,
  getProgramDerivedAddress,
  getStructDecoder,
  getU128Decoder,
  getU16Decoder,
  getU32Decoder,
  getU64Decoder,
  getU8Decoder,
  getUtf8Decoder,
  getUtf8Encoder,
  transformDecoder,
  type Address,
  type Decoder,
} from "@solana/kit";
import type { Cluster, JsonRpc, Receipt } from "./types.js";

export const SAS_PROGRAM_ID = "22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG";
const ATTESTATION_DISCRIMINATOR = 2;
const SCHEMA_DISCRIMINATOR = 1;

export type Deployment = { cluster: Cluster; credential: string; schema: string };

/** The 32 bytes sha256(`${subject_id}@${version}`), as a base58 address. */
export function receiptNonce(subjectId: string, version: string): Address {
  const bytes = createHash("sha256").update(`${subjectId}@${version}`).digest();
  return getAddressDecoder().decode(bytes);
}

/** Where the attestation for one (subject, version) lives. */
export async function receiptAddress(subjectId: string, version: string, d: Pick<Deployment, "credential" | "schema">): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: SAS_PROGRAM_ID as Address,
    seeds: [
      getUtf8Encoder().encode("attestation"),
      getAddressEncoder().encode(d.credential as Address),
      getAddressEncoder().encode(d.schema as Address),
      getAddressEncoder().encode(receiptNonce(subjectId, version)),
    ],
  });
  return pda;
}

export function explorerUrl(address: string, cluster: Cluster): string {
  return `https://explorer.solana.com/address/${address}${cluster === "devnet" ? "?cluster=devnet" : ""}`;
}

// ── account layouts ──────────────────────────────────────────────────────────

const text = () => addDecoderSizePrefix(getUtf8Decoder(), getU32Decoder());

const attestationDecoder = getStructDecoder([
  ["discriminator", getU8Decoder()],
  ["nonce", getAddressDecoder()],
  ["credential", getAddressDecoder()],
  ["schema", getAddressDecoder()],
  ["data", addDecoderSizePrefix(getBytesDecoder(), getU32Decoder())],
  ["signer", getAddressDecoder()],
  ["expiry", getI64Decoder()],
  ["tokenAccount", getAddressDecoder()],
]);

const schemaDecoder = getStructDecoder([
  ["discriminator", getU8Decoder()],
  ["credential", getAddressDecoder()],
  ["name", text()],
  ["description", text()],
  ["layout", addDecoderSizePrefix(getArrayDecoder(getU8Decoder(), { size: "remainder" }), getU32Decoder())],
  ["fieldNames", addDecoderSizePrefix(getArrayDecoder(text(), { size: "remainder" }), getU32Decoder())],
  ["isPaused", getBooleanDecoder()],
  ["version", getU8Decoder()],
]);

/** SAS SchemaDataType, in program order. */
const TYPE_NAMES = ["U8", "U16", "U32", "U64", "U128", "I8", "I16", "I32", "I64", "I128", "Bool", "Char", "String", "VecU8", "VecU16", "VecU32", "VecU64", "VecU128", "VecI8", "VecI16", "VecI32", "VecI64", "VecI128", "VecBool", "VecChar", "VecString"] as const;

const hex = getBase16Decoder();

/** A String field may hold raw bytes (a hash): read UTF-8 strictly, else give 0x-hex. */
const stringField = (): Decoder<string> => {
  const strict = new TextDecoder("utf-8", { fatal: true });
  return transformDecoder(addDecoderSizePrefix(getBytesDecoder(), getU32Decoder()), (b): string => {
    try {
      return strict.decode(b);
    } catch {
      return `0x${hex.decode(b)}`;
    }
  });
};

const charField = (): Decoder<string> =>
  transformDecoder(getU32Decoder(), (cp): string => {
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw new Error(`Char field holds ${cp}, which is not a Unicode character`);
    return String.fromCodePoint(cp);
  });

const boolField = (): Decoder<boolean> =>
  transformDecoder(getU8Decoder(), (v): boolean => {
    if (v > 1) throw new Error(`Bool field holds ${v}, which is neither 0 nor 1`);
    return v === 1;
  });

// The decoder for one layout entry. Scalars first, then the Vec forms of them.
function fieldDecoder(type: string): Decoder<unknown> {
  switch (type) {
    case "U8": return getU8Decoder();
    case "U16": return getU16Decoder();
    case "U32": return getU32Decoder();
    case "U64": return getU64Decoder();
    case "U128": return getU128Decoder();
    case "I8": return getI8Decoder();
    case "I16": return getI16Decoder();
    case "I32": return getI32Decoder();
    case "I64": return getI64Decoder();
    case "I128": return getI128Decoder();
    case "Bool": return boolField();
    case "Char": return charField();
    case "String": return stringField();
    default:
      if (type.startsWith("Vec")) return getArrayDecoder(fieldDecoder(type.slice(3)));
      throw new Error(`unknown schema data type ${type}`);
  }
}

export type SchemaAccount = { credential: string; name: string; layout: string[]; fieldNames: string[]; isPaused: boolean; version: number };

export function decodeSchemaAccount(bytes: Uint8Array): SchemaAccount {
  const s = schemaDecoder.decode(bytes);
  if (s.discriminator !== SCHEMA_DISCRIMINATOR) throw new Error(`account is not a SAS schema (discriminator ${s.discriminator})`);
  const layout = s.layout.map((t) => {
    const name = TYPE_NAMES[t];
    if (!name) throw new Error(`schema layout holds unknown data type ${t}`);
    return name;
  });
  if (layout.length !== s.fieldNames.length) throw new Error("schema field names and layout do not match");
  return { credential: s.credential, name: s.name, layout, fieldNames: [...s.fieldNames], isPaused: s.isPaused, version: s.version };
}

export function decodeAttestationData(schema: Pick<SchemaAccount, "layout" | "fieldNames">, data: Uint8Array): Record<string, unknown> {
  const dec = getStructDecoder(schema.fieldNames.map((n, i) => [n, fieldDecoder(schema.layout[i])] as const));
  return dec.decode(data) as Record<string, unknown>;
}

const asString = (v: unknown, field: string): string => {
  if (typeof v !== "string") throw new Error(`receipt field ${field} is not a string`);
  return v;
};

/** 32 raw bytes (VecU8) or hex text (String, with or without 0x) to lower-case hex. */
export function digestToHex(v: unknown): string {
  if (Array.isArray(v) && v.length === 32 && v.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) return Buffer.from(v as number[]).toString("hex");
  if (typeof v === "string") {
    const h = v.replace(/^0x/i, "").toLowerCase();
    if (/^[0-9a-f]{64}$/.test(h)) return h;
  }
  throw new Error("receipt digest is not 32 bytes");
}

/** The receipt fields from a decoded data blob. Throws on a blob that is not a receipt. */
export function receiptFromData(data: Record<string, unknown>): Omit<Receipt, "attestation_address" | "cluster" | "explorer_url"> {
  const count = data.fund_action_count;
  const n = typeof count === "number" ? count : typeof count === "bigint" ? Number(count) : null;
  return {
    subject_kind: asString(data.subject_kind, "subject_kind"),
    subject_id: asString(data.subject_id, "subject_id"),
    version: asString(data.version, "version"),
    digest_hex: digestToHex(data.digest),
    key_access: asString(data.key_access, "key_access"),
    key_egress: asString(data.key_egress, "key_egress"),
    fund_action_count: n === null || n < 0 ? null : n,
    method_version: asString(data.method_version, "method_version"),
    as_of: asString(data.as_of, "as_of"),
    reading_url: asString(data.reading_url, "reading_url"),
  };
}

// ── reading ──────────────────────────────────────────────────────────────────

type AccountInfo = { data: [string, string]; owner: string } | null;

const accountBytes = (a: NonNullable<AccountInfo>): Uint8Array => new Uint8Array(Buffer.from(a.data[0], "base64"));

/** getMultipleAccounts allows 100 addresses per call. */
const BATCH = 99;

export type SubjectKey = { subject_id: string; version: string };
export type ChainResult = { ok: true; receipt: Receipt | null; note?: string } | { ok: false; error: string };

/**
 * Reads the receipt for each (subject, version), from the cluster the
 * deployment names. One getMultipleAccounts call per 99 subjects, with the
 * schema account first. A subject with no attestation is `receipt: null`.
 */
export async function readReceiptsFromChain(rpc: JsonRpc, d: Deployment, keys: readonly SubjectKey[], now: () => number = Date.now): Promise<Map<string, ChainResult>> {
  const out = new Map<string, ChainResult>();
  const id = (k: SubjectKey) => `${k.subject_id}@${k.version}`;
  if (keys.length === 0) return out;

  const addresses = await Promise.all(keys.map((k) => receiptAddress(k.subject_id, k.version, d)));
  let schema: SchemaAccount | null = null;
  let schemaError: string | null = null;

  for (let i = 0; i < keys.length; i += BATCH) {
    const chunkKeys = keys.slice(i, i + BATCH);
    const chunkAddrs = addresses.slice(i, i + BATCH);
    const asked = i === 0 ? [d.schema, ...chunkAddrs] : chunkAddrs;
    let value: AccountInfo[];
    try {
      const r = (await rpc("getMultipleAccounts", [asked, { encoding: "base64", commitment: "confirmed" }])) as { value?: AccountInfo[] };
      if (!Array.isArray(r?.value) || r.value.length !== asked.length) throw new Error("getMultipleAccounts returned an unexpected shape");
      value = r.value;
    } catch (e) {
      for (const k of chunkKeys) out.set(id(k), { ok: false, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (i === 0) {
      const sa = value.shift() ?? null;
      if (!sa) schemaError = `the schema account ${d.schema} does not exist on ${d.cluster}`;
      else if (sa.owner !== SAS_PROGRAM_ID) schemaError = `the schema account ${d.schema} is not owned by the SAS program`;
      else {
        try {
          schema = decodeSchemaAccount(accountBytes(sa));
          if (schema.credential !== d.credential) schemaError = "the schema belongs to a different credential than receipts.config.json names";
        } catch (e) {
          schemaError = `could not read the schema account: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
    }
    chunkKeys.forEach((k, j) => {
      if (schemaError || !schema) return void out.set(id(k), { ok: false, error: schemaError ?? "schema not read" });
      const acct = value[j];
      if (!acct) return void out.set(id(k), { ok: true, receipt: null });
      try {
        if (acct.owner !== SAS_PROGRAM_ID) throw new Error("the account at the receipt address is not owned by the SAS program");
        const a = attestationDecoder.decode(accountBytes(acct));
        if (a.discriminator !== ATTESTATION_DISCRIMINATOR) throw new Error(`account is not an attestation (discriminator ${a.discriminator})`);
        if (a.credential !== d.credential || a.schema !== d.schema) throw new Error("the attestation names a different credential or schema");
        if (a.nonce !== receiptNonce(k.subject_id, k.version)) throw new Error("the attestation nonce does not match the subject and version");
        if (a.expiry !== 0n && a.expiry < BigInt(Math.floor(now() / 1000))) return void out.set(id(k), { ok: true, receipt: null, note: "the attestation has expired" });
        const fields = receiptFromData(decodeAttestationData(schema, new Uint8Array(a.data)));
        if (fields.subject_id !== k.subject_id || fields.version !== k.version) throw new Error("the attestation data names a different subject or version");
        const address = addresses[i + j];
        out.set(id(k), { ok: true, receipt: { ...fields, attestation_address: address, cluster: d.cluster, explorer_url: explorerUrl(address, d.cluster) } });
      } catch (e) {
        out.set(id(k), { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  }
  return out;
}
