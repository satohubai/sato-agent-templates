// npm run preflight
//
// For each installed dependency that handles keys (every direct dependency plus
// the watch list in receipts.config.json), hash the exact npm tarball the
// lockfile pins, read that build's Sato Check receipt from Solana, and print
// what the receipt says and whether it is the same build.
//
// Read-only: it downloads tarballs from the npm registry, reads Solana accounts
// over JSON-RPC, and holds no key. Exit code 0 unless --strict is given.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isMain } from "../is-main.js";
import { ConfigError, parseReceiptsConfig, runPreflight, strictFailures, type PreflightReport, type SourceMode } from "./check.js";
import { LockError, selectSubjects, type LockFile, type PackageJson } from "./lock.js";
import { renderReport } from "./table.js";
import type { JsonRpc } from "./types.js";

export const USAGE = `usage: npm run preflight -- [options]

  --strict            exit 1 when an installed build differs from its reading, a tarball
                      differs from package-lock.json, or Sato Check observed a key leave
  --require-reading   with --strict, also exit 1 for "no reading" and "could not check"
  --all               check the whole production closure, not just keys-touching packages
  --only a,b          check only these package names
  --source auto|chain|api
                      auto (default): read Solana when receipts.config.json names the
                      credential and schema, else the Sato Hub API
  --config <file>     receipts.config.json (default ./receipts.config.json)
  --package <file>    package.json (default ./package.json)
  --lock <file>       package-lock.json (default ./package-lock.json)
  --json              print the report as JSON instead of text
  --out <dir>         where out/preflight.json is written (default out; "none" to skip)

Environment: SATO_RECEIPTS_RPC_URL overrides the Solana RPC for the receipts read.`;

export class UsageError extends Error {}

export type Args = {
  strict: boolean;
  requireReading: boolean;
  all: boolean;
  only: string[];
  source: SourceMode;
  config: string;
  pkg: string;
  lock: string;
  json: boolean;
  out: string;
};

export function parseArgs(argv: readonly string[]): Args {
  const a: Args = { strict: false, requireReading: false, all: false, only: [], source: "auto", config: "receipts.config.json", pkg: "package.json", lock: "package-lock.json", json: false, out: "out" };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${f} needs a value`);
      return v;
    };
    if (f === "--strict") a.strict = true;
    else if (f === "--require-reading") a.requireReading = true;
    else if (f === "--all") a.all = true;
    else if (f === "--json") a.json = true;
    else if (f === "--only") a.only = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (f === "--source") {
      const v = next();
      if (v !== "auto" && v !== "chain" && v !== "api") throw new UsageError("--source must be auto, chain or api");
      a.source = v;
    } else if (f === "--config") a.config = next();
    else if (f === "--package") a.pkg = next();
    else if (f === "--lock") a.lock = next();
    else if (f === "--out") a.out = next();
    else if (f === "--help" || f === "-h") throw new UsageError(USAGE);
    else throw new UsageError(`unknown argument ${JSON.stringify(f)}\n\n${USAGE}`);
  }
  if (a.requireReading && !a.strict) throw new UsageError("--require-reading only means something with --strict");
  return a;
}

export function reportJson(report: PreflightReport, failures: string[]): unknown {
  return {
    schema: "solana-guarded-swapper.preflight/v1",
    cluster: report.cluster,
    source_note: report.source_note,
    sources_used: report.sources_used,
    describes_not_grades: "A reading describes what Sato Check found in one exact build on one date. It is not a safety rating, an audit or an endorsement.",
    strict_failures: failures,
    packages: report.rows.map((r) => ({
      name: r.subject.name,
      version: r.subject.version,
      subject_id: r.subject.subject_id,
      checked_because: r.subject.reason,
      status: r.status,
      detail: r.detail,
      installed_sha256: r.installed_digest_hex,
      source: r.source,
      reading: r.receipt && {
        as_of: r.receipt.as_of,
        key_access: r.receipt.key_access,
        key_egress: r.receipt.key_egress,
        fund_action_count: r.receipt.fund_action_count,
        method_version: r.receipt.method_version,
        recorded_sha256: r.receipt.digest_hex,
        reading_url: r.receipt.reading_url,
        attestation_address: r.receipt.attestation_address,
        explorer_url: r.receipt.explorer_url,
      },
    })),
  };
}

export type Io = {
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  log: (s: string) => void;
  err: (s: string) => void;
  /** Tests only: a JSON-RPC caller to use instead of one over fetch. */
  rpc?: JsonRpc;
};

/** Returns the exit code. 0 unless --strict finds a problem; 2 when the check could not run (bad options or files). */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    io.err(e instanceof Error ? e.message : String(e));
    return 2;
  }
  try {
    const read = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
    const config = parseReceiptsConfig(read(args.config));
    const subjects = selectSubjects(read<PackageJson>(args.pkg), read<LockFile>(args.lock), { watch: config.watch, all: args.all, only: args.only });
    if (subjects.length === 0) {
      io.err(args.only.length ? "none of the --only packages are locked production dependencies" : "no production dependencies found in package-lock.json");
      return 2;
    }
    const projectDir = dirname(resolve(args.lock));
    const report = await runPreflight({ subjects, config, fetch: io.fetch, projectDir, source: args.source, rpc: io.rpc, rpcUrlEnv: io.env.SATO_RECEIPTS_RPC_URL || null });
    const failures = args.strict ? strictFailures(report.rows, args.requireReading) : [];
    const json = reportJson(report, failures);
    io.log(args.json ? JSON.stringify(json, null, 2) : renderReport(report));
    if (args.out !== "none") {
      mkdirSync(args.out, { recursive: true });
      writeFileSync(join(args.out, "preflight.json"), JSON.stringify(json, null, 2) + "\n");
    }
    if (failures.length > 0) {
      io.err(`\n--strict: ${failures.length} problem${failures.length === 1 ? "" : "s"}`);
      for (const f of failures) io.err(`  ${f}`);
      return 1;
    }
    return 0;
  } catch (e) {
    if (e instanceof ConfigError || e instanceof LockError || (e as NodeJS.ErrnoException)?.code === "ENOENT" || e instanceof SyntaxError) {
      io.err(`preflight: ${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }
    throw e;
  }
}

if (isMain(import.meta.url)) {
  run(process.argv.slice(2), { fetch: globalThis.fetch, env: process.env, log: (s) => console.log(s), err: (s) => console.error(s) }).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`preflight stopped: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}
