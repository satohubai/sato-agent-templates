// The sha256 of the exact npm tarball a lockfile pins.
//
// The lockfile records, for each package, the tarball URL npm installed from
// (`resolved`) and its integrity (`sha512-...`). This module downloads that
// tarball again, checks the bytes against the lockfile's integrity, and hashes
// them with sha256: the digest a Sato Check receipt is filed under. If the
// bytes do not match the lockfile, no digest is returned: the lockfile and the
// registry disagree, and that is worth knowing before any receipt is read.
//
// A package installed from a local `file:` tarball (a vendored build) is hashed
// from that file instead.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { DigestResult, Fetch, Subject } from "./types.js";

export const REGISTRY = "https://registry.npmjs.org/";
export const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
export const USER_AGENT = "sato-template/solana-guarded-swapper@0.1.0 (preflight)";

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Does the SRI string (sha512-<base64>, possibly several, space separated) match these bytes? null = no usable hash in it. */
export function integrityMatches(integrity: string | null, bytes: Uint8Array): boolean | null {
  if (!integrity) return null;
  let usable = false;
  for (const part of integrity.split(/\s+/).filter(Boolean)) {
    const m = /^(sha512|sha384|sha256|sha1)-(.+)$/.exec(part);
    if (!m) continue;
    usable = true;
    if (createHash(m[1]).update(bytes).digest("base64") === m[2]) return true;
  }
  return usable ? false : null;
}

async function download(url: string, fetchImpl: Fetch, timeoutMs: number): Promise<Uint8Array> {
  const res = await fetchImpl(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > MAX_TARBALL_BYTES) throw new Error(`tarball is ${buf.length} bytes, over the ${MAX_TARBALL_BYTES} byte limit`);
  return buf;
}

/** dist.tarball and dist.integrity from the registry, for a lock entry that has no `resolved`. */
async function distFromRegistry(s: Subject, fetchImpl: Fetch, timeoutMs: number): Promise<{ tarball: string; integrity: string | null }> {
  const url = `${REGISTRY}${s.name.replace("/", "%2F")}/${s.version}`;
  const res = await fetchImpl(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`registry answered HTTP ${res.status} for ${s.name}@${s.version}`);
  const j = (await res.json()) as { dist?: { tarball?: string; integrity?: string; shasum?: string } };
  if (!j.dist?.tarball) throw new Error("registry returned no dist.tarball");
  return { tarball: j.dist.tarball, integrity: j.dist.integrity ?? (j.dist.shasum ? `sha1-${Buffer.from(j.dist.shasum, "hex").toString("base64")}` : null) };
}

export type DigestOptions = { fetch: Fetch; projectDir: string; timeoutMs?: number };

export async function digestInstalled(s: Subject, o: DigestOptions): Promise<DigestResult> {
  const timeoutMs = o.timeoutMs ?? 30_000;
  try {
    if (s.resolved?.startsWith("file:")) {
      const rel = s.resolved.slice("file:".length);
      const root = resolve(o.projectDir);
      const file = resolve(root, rel);
      if (file !== root && !file.startsWith(root + sep)) return { ok: false, reason: "unreachable", detail: `${rel} is outside the project` };
      const bytes = new Uint8Array(readFileSync(join(file)));
      const m = integrityMatches(s.integrity, bytes);
      if (m === false) return { ok: false, reason: "lock_mismatch", detail: `${rel} does not match the integrity in package-lock.json` };
      return { ok: true, digest_hex: sha256Hex(bytes), origin: "vendored", lock_integrity: m === null ? "not_in_lock" : "match" };
    }
    let url = s.resolved;
    let integrity = s.integrity;
    if (!url) {
      const d = await distFromRegistry(s, o.fetch, timeoutMs);
      url = d.tarball;
      integrity = integrity ?? d.integrity;
    }
    if (!url.startsWith(REGISTRY)) return { ok: false, reason: "unreachable", detail: `resolved outside the npm registry (${new URL(url).host}); not downloaded` };
    const bytes = await download(url, o.fetch, timeoutMs);
    const m = integrityMatches(integrity, bytes);
    if (m === false) return { ok: false, reason: "lock_mismatch", detail: "the tarball the registry serves does not match the integrity in package-lock.json" };
    return { ok: true, digest_hex: sha256Hex(bytes), origin: "registry", lock_integrity: m === null ? "not_in_lock" : "match" };
  } catch (e) {
    return { ok: false, reason: "unreachable", detail: e instanceof Error ? e.message : String(e) };
  }
}
