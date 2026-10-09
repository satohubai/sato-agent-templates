// npm run preflight end to end, with a mocked Solana RPC, a mocked receipts API
// and mocked tarballs. Nothing here touches the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReceipt, readReceiptFromApi } from "../src/preflight/api.js";
import { chainConfigured, parseReceiptsConfig, runPreflight, strictFailures, ConfigError, type ReceiptsConfig } from "../src/preflight/check.js";
import { run } from "../src/preflight/cli.js";
import { matchesWatch, nameFromLockPath, selectSubjects } from "../src/preflight/lock.js";
import { receiptAddress, SAS_PROGRAM_ID } from "../src/preflight/sas.js";
import { digestInstalled, integrityMatches, sha256Hex } from "../src/preflight/tarball.js";
import { FOOTER, renderReport } from "../src/preflight/table.js";
import type { JsonRpc, Receipt, Subject } from "../src/preflight/types.js";

const golden = JSON.parse(readFileSync("test/fixtures/sas-golden.json", "utf8")) as { credential: string; schema: string; vec_u8: { schema_b64: string; attestation_b64: string; digest_hex: string } };

// ── fake registry ────────────────────────────────────────────────────────────

const sri = (b: Buffer) => `sha512-${createHash("sha512").update(b).digest("base64")}`;
const registryUrl = (name: string, v: string) => `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${v}.tgz`;

/** Bytes the golden attestation is filed under: the kit's tarball. */
const KIT_BYTES = Buffer.from("pretend this is the @satohub/kit 0.1.1 tarball");
const OTHER_BYTES = Buffer.from("pretend this is viem 2.57.2, which has no reading");
const CHANGED_BYTES = Buffer.from("pretend this is @solana/kit, republished since its reading");

function fakeFetch(files: Record<string, Buffer | number>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const f = files[url];
    if (f === undefined) return new Response("not found", { status: 404 });
    if (typeof f === "number") return new Response("error", { status: f });
    return new Response(new Uint8Array(f), { status: 200 });
  }) as typeof fetch;
}

const lockEntry = (name: string, version: string, bytes: Buffer, extra: object = {}) => ({ version, resolved: registryUrl(name, version), integrity: sri(bytes), ...extra });

const LOCK = {
  lockfileVersion: 3,
  packages: {
    "": {},
    "node_modules/@satohub/kit": lockEntry("@satohub/kit", "0.1.1", KIT_BYTES),
    "node_modules/viem": lockEntry("viem", "2.57.2", OTHER_BYTES),
    "node_modules/@solana/kit": lockEntry("@solana/kit", "8.4.0", CHANGED_BYTES),
    "node_modules/zod": lockEntry("zod", "4.6.5", Buffer.from("zod")),
    "node_modules/tsx": lockEntry("tsx", "4.23.15", Buffer.from("tsx"), { dev: true }),
  },
};
const PKG = { dependencies: { "@satohub/kit": "0.1.1", viem: "2.57.2", "@solana/kit": "8.4.0" }, devDependencies: { tsx: "4.23.15" } };

const FILES: Record<string, Buffer> = {
  [registryUrl("@satohub/kit", "0.1.1")]: KIT_BYTES,
  [registryUrl("viem", "2.57.2")]: OTHER_BYTES,
  [registryUrl("@solana/kit", "8.4.0")]: CHANGED_BYTES,
  [registryUrl("zod", "4.6.5")]: Buffer.from("zod"),
};

const CHAIN_CFG: ReceiptsConfig = {
  cluster: "devnet",
  credential: golden.credential,
  receipt_schema: golden.schema,
  rpc_url: null,
  api_url: "https://satohub.ai/api/check/receipt",
  watch: ["@satohub/kit", "@solana/kit"],
};

// The golden attestation is for npm:@satohub/kit@0.1.1 and records this digest.
// To make "same build" we need a tarball whose sha256 is that digest, so build
// a second attestation for the kit whose digest equals our fake tarball's.
function attestationWithDigest(hex: string): string {
  const bytes = Buffer.from(golden.vec_u8.attestation_b64, "base64");
  // data = u32 length + fields; the digest is the only 32-byte VecU8 (u32 count 32 then 32 bytes) in it.
  const at = bytes.indexOf(Buffer.from(golden.vec_u8.digest_hex, "hex"));
  assert.ok(at > 4, "the golden digest is in the attestation bytes");
  Buffer.from(hex, "hex").copy(bytes, at);
  return bytes.toString("base64");
}

async function chainRpc(opts: { kitDigest: string }): Promise<JsonRpc> {
  const kitAddr = await receiptAddress("npm:@satohub/kit", "0.1.1", { credential: golden.credential, schema: golden.schema });
  const accounts: Record<string, { data: [string, string]; owner: string } | null> = {
    [golden.schema]: { data: [golden.vec_u8.schema_b64, "base64"], owner: SAS_PROGRAM_ID },
    [kitAddr]: { data: [attestationWithDigest(opts.kitDigest), "base64"], owner: SAS_PROGRAM_ID },
  };
  return async (method, params) => {
    assert.equal(method, "getMultipleAccounts");
    return { value: (params as [string[]])[0].map((a) => accounts[a] ?? null) };
  };
}

const subjects = (watch = CHAIN_CFG.watch): Subject[] => selectSubjects(PKG, LOCK, { watch, all: false });

// ── lock selection ───────────────────────────────────────────────────────────

test("lock: names come from the last node_modules segment; watch patterns match by prefix or name", () => {
  assert.equal(nameFromLockPath("node_modules/a/node_modules/@s/b"), "@s/b");
  assert.ok(matchesWatch("@solana/keys", ["@solana/*"]));
  assert.ok(!matchesWatch("@solanax/keys", ["@solana/*"]));
  assert.ok(matchesWatch("viem", ["viem"]));
  assert.ok(!matchesWatch("viem-extra", ["viem"]));
});

test("lock: direct dependencies and watched packages are checked; dev packages and unwatched transitive ones are not", () => {
  const s = subjects();
  assert.deepEqual(s.map((x) => `${x.name}@${x.version}:${x.reason}`), ["@satohub/kit@0.1.1:direct", "@solana/kit@8.4.0:direct", "viem@2.57.2:direct"]);
  const all = selectSubjects(PKG, LOCK, { watch: [], all: true });
  assert.ok(all.some((x) => x.name === "zod" && x.reason === "all"));
  assert.ok(!all.some((x) => x.name === "tsx"), "a dev dependency is never checked");
  assert.deepEqual(selectSubjects(PKG, LOCK, { watch: [], all: true, only: ["viem"] }).map((x) => x.name), ["viem"]);
});

// ── tarball hashing ──────────────────────────────────────────────────────────

test("tarball: sha256 of the exact bytes, checked against the lockfile's integrity first", async () => {
  const [kit] = subjects();
  const d = await digestInstalled(kit, { fetch: fakeFetch(FILES), projectDir: "." });
  assert.ok(d.ok);
  assert.equal(d.ok && d.digest_hex, createHash("sha256").update(KIT_BYTES).digest("hex"));
  assert.equal(d.ok && d.lock_integrity, "match");
  assert.equal(sha256Hex(KIT_BYTES), createHash("sha256").update(KIT_BYTES).digest("hex"));
});

test("tarball: bytes that do not match the lockfile give no digest", async () => {
  const [kit] = subjects();
  const d = await digestInstalled(kit, { fetch: fakeFetch({ [registryUrl("@satohub/kit", "0.1.1")]: Buffer.from("something else") }), projectDir: "." });
  assert.equal(d.ok, false);
  assert.equal(!d.ok && d.reason, "lock_mismatch");
});

test("tarball: an unreachable registry is 'unreachable', and a tarball URL outside the registry is not downloaded", async () => {
  const [kit] = subjects();
  const down = await digestInstalled(kit, { fetch: fakeFetch({ [registryUrl("@satohub/kit", "0.1.1")]: 503 }), projectDir: "." });
  assert.equal(!down.ok && down.reason, "unreachable");
  let asked = 0;
  const spy = (async () => { asked++; return new Response("x"); }) as typeof fetch;
  const off = await digestInstalled({ ...kit, resolved: "https://example.com/evil.tgz" }, { fetch: spy, projectDir: "." });
  assert.equal(!off.ok && off.reason, "unreachable");
  assert.equal(asked, 0, "nothing was requested from outside the registry");
});

test("tarball: with no `resolved`, the registry's dist.tarball and dist.integrity are used", async () => {
  const [kit] = subjects();
  const noResolved: Subject = { ...kit, resolved: null, integrity: null };
  const dist = { dist: { tarball: registryUrl("@satohub/kit", "0.1.1"), integrity: sri(KIT_BYTES) } };
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://registry.npmjs.org/@satohub%2Fkit/0.1.1") return new Response(JSON.stringify(dist));
    return url === dist.dist.tarball ? new Response(new Uint8Array(KIT_BYTES)) : new Response("no", { status: 404 });
  }) as typeof fetch;
  const d = await digestInstalled(noResolved, { fetch: fetchImpl, projectDir: "." });
  assert.ok(d.ok && d.digest_hex === sha256Hex(KIT_BYTES));
});

test("tarball: a vendored file: package is hashed from the file, and must stay inside the project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sgs-vendor-"));
  writeFileSync(join(dir, "vendor.tgz"), KIT_BYTES);
  const [kit] = subjects();
  const v: Subject = { ...kit, resolved: "file:vendor.tgz", integrity: sri(KIT_BYTES) };
  const d = await digestInstalled(v, { fetch: fakeFetch({}), projectDir: dir });
  assert.ok(d.ok && d.origin === "vendored" && d.digest_hex === sha256Hex(KIT_BYTES));
  const out = await digestInstalled({ ...v, resolved: "file:../../etc/passwd" }, { fetch: fakeFetch({}), projectDir: dir });
  assert.equal(!out.ok && out.reason, "unreachable");
  assert.equal(integrityMatches(null, KIT_BYTES), null);
  assert.equal(integrityMatches("sha512-AAAA", KIT_BYTES), false);
});

// ── the receipts API ─────────────────────────────────────────────────────────

const apiBody = (o: object = {}) => ({ subject_kind: "package", subject_id: "npm:viem", version: "2.57.2", digest_hex: sha256Hex(OTHER_BYTES), key_access: "reads", key_egress: "unknown", fund_action_count: 3, method_version: "custody-2", as_of: "2026-10-05", reading_url: "https://satohub.ai/check/package/npm%3Aviem", ...o });

test("api: a receipt object, a { receipt } wrapper and a bare digest all parse; anything else is not a receipt", () => {
  assert.equal(parseReceipt(apiBody())?.digest_hex, sha256Hex(OTHER_BYTES));
  assert.equal(parseReceipt({ receipt: apiBody() })?.key_access, "reads");
  const { digest_hex, ...rest } = apiBody();
  assert.equal(parseReceipt({ ...rest, digest: digest_hex })?.digest_hex, digest_hex);
  assert.equal(parseReceipt({ receipt: null }), null);
  assert.equal(parseReceipt("nope"), null);
  assert.equal(parseReceipt({ subject_id: "x" }), null);
});

test("api: 404 with JSON is 'no reading'; 404 with HTML is 'the route is not there', which is an error", async () => {
  const mk = (status: number, body: string, type: string) => (async () => new Response(body, { status, headers: { "content-type": type } })) as typeof fetch;
  assert.deepEqual(await readReceiptFromApi(mk(404, '{"receipt":null}', "application/json"), "https://satohub.ai/api/check/receipt", "npm:viem", "2.57.2"), { ok: true, receipt: null });
  const html = await readReceiptFromApi(mk(404, "<html>404</html>", "text/html"), "https://satohub.ai/api/check/receipt", "npm:viem", "2.57.2");
  assert.equal(html.ok, false);
  const wrong = await readReceiptFromApi(mk(200, JSON.stringify(apiBody({ version: "9.9.9" })), "application/json"), "https://satohub.ai/api/check/receipt", "npm:viem", "2.57.2");
  assert.equal(wrong.ok, false, "a receipt for another version is not an answer for this one");
  const ok = await readReceiptFromApi(mk(200, JSON.stringify(apiBody()), "application/json"), "https://satohub.ai/api/check/receipt", "npm:viem", "2.57.2");
  assert.ok(ok.ok && ok.receipt?.key_access === "reads");
});

test("api: the request carries the id and version and a Sato user agent", async () => {
  let seen: { url: string; ua: string | null } | null = null;
  const spy = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = { url: String(input), ua: new Headers(init?.headers).get("user-agent") };
    return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  await readReceiptFromApi(spy, "https://satohub.ai/api/check/receipt", "npm:@satohub/kit", "0.1.1");
  assert.equal(new URL(seen!.url).searchParams.get("id"), "npm:@satohub/kit");
  assert.equal(new URL(seen!.url).searchParams.get("version"), "0.1.1");
  assert.match(seen!.ua ?? "", /^sato-template\//);
});

// ── the whole check ──────────────────────────────────────────────────────────

test("chain: same build, different build and no reading, in one table, read from Solana", async () => {
  // The kit's reading matches its tarball. @solana/kit has no attestation. viem has none either.
  const rpc = await chainRpc({ kitDigest: sha256Hex(KIT_BYTES) });
  const report = await runPreflight({ subjects: subjects(), config: { ...CHAIN_CFG, api_url: null }, fetch: fakeFetch(FILES), projectDir: ".", rpc });
  const by = Object.fromEntries(report.rows.map((r) => [r.subject.name, r]));
  assert.equal(by["@satohub/kit"].status, "same_build");
  assert.equal(by["@satohub/kit"].source, "chain");
  assert.equal(by["viem"].status, "no_receipt");
  assert.equal(by["@solana/kit"].status, "no_receipt");
  assert.match(report.source_note, /Read from Solana devnet/);
  assert.match(report.source_note, /no key and no call to Sato Hub/);

  const text = renderReport(report);
  assert.match(text, /@satohub\/kit@0\.1\.1\s+2026-10-05\s+no key read found\s+not observed\s+✓ same build as recorded/);
  assert.match(text, /viem@2\.57\.2\s+—\s+—\s+—\s+— no reading for this version/);
  assert.match(text, /explorer\.solana\.com\/address\/.*cluster=devnet/);
});

test("chain: a reading recorded for other bytes is 'different build', and --strict says so", async () => {
  const rpc = await chainRpc({ kitDigest: "ab".repeat(32) });
  const report = await runPreflight({ subjects: subjects(), config: { ...CHAIN_CFG, api_url: null }, fetch: fakeFetch(FILES), projectDir: ".", rpc });
  const kit = report.rows.find((r) => r.subject.name === "@satohub/kit")!;
  assert.equal(kit.status, "different_build");
  assert.match(renderReport(report), /⚠ different build/);
  assert.match(renderReport(report), /recorded sha256 abababababab…, installed sha256 /);
  assert.equal(strictFailures(report.rows, false).length, 1);
  assert.match(strictFailures(report.rows, false)[0], /differs from the one the reading was recorded for/);
  // "no reading" only fails with --require-reading.
  assert.equal(strictFailures(report.rows, true).length, 3);
});

test("chain: a key observed leaving fails --strict even when it is the same build", async () => {
  const rpc = await chainRpc({ kitDigest: sha256Hex(KIT_BYTES) });
  const report = await runPreflight({ subjects: subjects(), config: { ...CHAIN_CFG, api_url: null }, fetch: fakeFetch(FILES), projectDir: ".", rpc });
  report.rows.find((r) => r.subject.name === "@satohub/kit")!.receipt!.key_egress = "observed";
  assert.match(strictFailures(report.rows, false)[0], /observed a planted test key leave/);
  assert.match(renderReport(report), /YES, observed/);
});

test("fallback: with no credential and schema set, the API is used and the output says so", async () => {
  const cfg: ReceiptsConfig = { ...CHAIN_CFG, credential: null, receipt_schema: null };
  assert.equal(chainConfigured(cfg), false);
  const api = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.host === "satohub.ai") {
      return url.searchParams.get("id") === "npm:viem"
        ? new Response(JSON.stringify(apiBody()), { headers: { "content-type": "application/json" } })
        : new Response('{"receipt":null}', { status: 404, headers: { "content-type": "application/json" } });
    }
    return fakeFetch(FILES)(input);
  }) as typeof fetch;
  const report = await runPreflight({ subjects: subjects(), config: cfg, fetch: api, projectDir: "." });
  const viem = report.rows.find((r) => r.subject.name === "viem")!;
  assert.equal(viem.status, "same_build", "the API's digest is the sha256 of viem's fake tarball");
  assert.equal(viem.source, "api");
  assert.equal(viem.receipt?.key_access, "reads");
  assert.deepEqual(report.sources_used, ["api"]);
  assert.match(report.source_note, /Not read from chain: the Sato Hub credential and receipt schema addresses are not set/);
  assert.match(report.source_note, /Read from the Sato Hub API \(satohub\.ai\); that is one call to a Sato Hub server, not a read of the chain/);
});

test("fallback: a chain read that fails falls back to the API, and says which rows came from where", async () => {
  const brokenRpc: JsonRpc = async () => {
    throw new Error("devnet.example answered HTTP 429");
  };
  const api = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.host === "satohub.ai") return new Response('{"receipt":null}', { status: 404, headers: { "content-type": "application/json" } });
    return fakeFetch(FILES)(input);
  }) as typeof fetch;
  const report = await runPreflight({ subjects: subjects(), config: CHAIN_CFG, fetch: api, projectDir: ".", rpc: brokenRpc });
  assert.ok(report.rows.every((r) => r.status === "no_receipt" && r.source === "api"));
  assert.match(report.source_note, /could not be read from chain/);
  assert.match(report.source_note, /Read from the Sato Hub API|For the rest, read from the Sato Hub API/);
});

test("nothing answering is 'could not check', never 'no reading'", async () => {
  const brokenRpc: JsonRpc = async () => {
    throw new Error("rpc down");
  };
  const report = await runPreflight({ subjects: subjects(), config: { ...CHAIN_CFG, api_url: null }, fetch: fakeFetch(FILES), projectDir: ".", rpc: brokenRpc });
  assert.ok(report.rows.every((r) => r.status === "unchecked"));
  assert.match(renderReport(report), /\? could not check/);
  assert.equal(strictFailures(report.rows, false).length, 0, "unchecked fails only with --require-reading");
  assert.equal(strictFailures(report.rows, true).length, 3);
});

test("a tarball the registry no longer serves as locked is flagged and never compared with a reading", async () => {
  const tampered = { ...FILES, [registryUrl("@satohub/kit", "0.1.1")]: Buffer.from("not what npm installed") };
  const rpc = await chainRpc({ kitDigest: sha256Hex(KIT_BYTES) });
  const report = await runPreflight({ subjects: subjects(), config: { ...CHAIN_CFG, api_url: null }, fetch: fakeFetch(tampered), projectDir: ".", rpc });
  const kit = report.rows.find((r) => r.subject.name === "@satohub/kit")!;
  assert.equal(kit.status, "lock_mismatch");
  assert.match(renderReport(report), /⚠ tarball differs from package-lock\.json/);
  assert.match(strictFailures(report.rows, false)[0], /does not match package-lock\.json/);
});

// ── config and output ────────────────────────────────────────────────────────

test("receipts.config.json ships with placeholders: no credential, no schema", () => {
  const cfg = parseReceiptsConfig(JSON.parse(readFileSync("receipts.config.json", "utf8")));
  assert.equal(cfg.credential, null);
  assert.equal(cfg.receipt_schema, null);
  assert.equal(chainConfigured(cfg), false);
  assert.equal(cfg.api_url, "https://satohub.ai/api/check/receipt");
  assert.ok(cfg.watch.includes("@satohub/kit"));
});

test("receipts.config.json is validated: one address without the other, a non-address, a non-https URL and unknown keys are refused", () => {
  const base = { schema: "sato.template-receipts/v1", cluster: "mainnet-beta", watch: [] };
  assert.throws(() => parseReceiptsConfig({ ...base, credential: golden.credential }), ConfigError);
  assert.throws(() => parseReceiptsConfig({ ...base, credential: "not an address", receipt_schema: golden.schema }), /base58/);
  assert.throws(() => parseReceiptsConfig({ ...base, rpc_url: "http://insecure.example" }), /https/);
  assert.throws(() => parseReceiptsConfig({ ...base, secret_key: "x" }), /unknown property/);
  assert.throws(() => parseReceiptsConfig({ ...base, cluster: "testnet" }), /cluster/);
  assert.ok(chainConfigured(parseReceiptsConfig({ ...base, credential: golden.credential, receipt_schema: golden.schema })));
});

test("the output describes and never grades", async () => {
  const rpc = await chainRpc({ kitDigest: sha256Hex(KIT_BYTES) });
  const report = await runPreflight({ subjects: subjects(), config: { ...CHAIN_CFG, api_url: null }, fetch: fakeFetch(FILES), projectDir: ".", rpc });
  const text = renderReport(report);
  const banned = /\b(safe|safer|safest|secure|trusted|trustworthy|verified|passed|audited|malicious|scam|risk-free|guaranteed)\b/i;
  assert.doesNotMatch(text, banned);
  for (const f of FOOTER) assert.doesNotMatch(f, banned);
  assert.match(text, /not a safety rating, an audit or an endorsement/);
});

// ── the command ──────────────────────────────────────────────────────────────

function project(): { dir: string; args: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "sgs-pf-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify(PKG));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify(LOCK));
  writeFileSync(join(dir, "receipts.config.json"), JSON.stringify({ schema: "sato.template-receipts/v1", cluster: "devnet", credential: golden.credential, receipt_schema: golden.schema, api_url: null, watch: ["@satohub/kit"] }));
  return { dir, args: ["--config", join(dir, "receipts.config.json"), "--package", join(dir, "package.json"), "--lock", join(dir, "package-lock.json"), "--out", join(dir, "out")] };
}

test("cli: exits 0 without --strict even on a different build, and 1 with it", async () => {
  const p = project();
  const rpc = await chainRpc({ kitDigest: "cd".repeat(32) });
  const out: string[] = [];
  const err: string[] = [];
  const io = { fetch: fakeFetch(FILES), env: {}, log: (s: string) => out.push(s), err: (s: string) => err.push(s), rpc };
  assert.equal(await run(p.args, io), 0);
  assert.match(out.join("\n"), /⚠ different build/);
  const written = JSON.parse(readFileSync(join(p.dir, "out", "preflight.json"), "utf8"));
  assert.equal(written.schema, "solana-guarded-swapper.preflight/v1");
  assert.equal(written.packages.find((x: { name: string }) => x.name === "@satohub/kit").status, "different_build");
  assert.equal(await run([...p.args, "--strict"], io), 1);
  assert.match(err.join("\n"), /--strict: 1 problem/);
});

test("cli: --json prints the report as JSON; a bad option or a missing file exits 2", async () => {
  const p = project();
  const rpc = await chainRpc({ kitDigest: sha256Hex(KIT_BYTES) });
  const out: string[] = [];
  const err: string[] = [];
  const io = { fetch: fakeFetch(FILES), env: {}, log: (s: string) => out.push(s), err: (s: string) => err.push(s), rpc };
  assert.equal(await run([...p.args, "--json"], io), 0);
  const j = JSON.parse(out.join("\n")) as { packages: { status: string }[]; describes_not_grades: string };
  assert.ok(j.packages.some((x) => x.status === "same_build"));
  assert.match(j.describes_not_grades, /not a safety rating/);
  assert.equal(await run(["--nope"], io), 2);
  assert.equal(await run(["--require-reading"], io), 2);
  assert.equal(await run([...p.args.slice(0, 2), "--package", join(p.dir, "missing.json")], io), 2);
});

test("a Receipt row type carries only reading fields, never a verdict", () => {
  const r: Receipt = { subject_kind: "package", subject_id: "npm:x", version: "1", digest_hex: "0".repeat(64), key_access: "unknown", key_egress: "unknown", fund_action_count: null, method_version: "custody-2", as_of: "2026-10-05", reading_url: "", attestation_address: null, cluster: null, explorer_url: null };
  assert.deepEqual(Object.keys(r).filter((k) => /safe|verdict|grade|score|trust/i.test(k)), []);
});
