#!/usr/bin/env node
// ci.yml's `ci-result` job: one stable check over discover + verify.
//   node scripts/ci-result.mjs <discover result> <verify result>
import { pathToFileURL } from "node:url";

/** Pure: {ok, reason} for needs.discover.result / needs.verify.result. */
export function ciResult(discover, verify) {
  if (discover !== "success") return { ok: false, reason: `discover ${discover || "did not run"}` };
  if (verify === "success") return { ok: true, reason: "verify succeeded" };
  if (verify === "skipped") return { ok: true, reason: "no template touched; verify skipped" };
  return { ok: false, reason: `verify ${verify || "did not run"}` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const r = ciResult(process.argv[2], process.argv[3]);
  console.log(`ci-result: ${r.ok ? "pass" : "fail"} (${r.reason})`);
  if (!r.ok) process.exitCode = 1;
}
