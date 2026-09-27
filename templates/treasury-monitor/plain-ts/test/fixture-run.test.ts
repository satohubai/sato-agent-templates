// End to end: the default command a generated repo is judged by.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("npm start -- --mode fixture exits 0, reads through the kit and writes the report", () => {
  const out = mkdtempSync(join(tmpdir(), "tm-"));
  const r = spawnSync("npm", ["start", "--silent", "--", "--mode", "fixture", "--out", out], { encoding: "utf8", timeout: 120_000, env: { ...process.env, ANVIL_RPC_URL: "", SATO_RPC_URL_BASE: "" } });
  const text = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 0, text);
  assert.match(text, /holds no key, signs nothing and moves no funds/);
  assert.match(text, /ALERT burn USDC below 100000000000/);
  const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
  assert.equal(report.source_kind, "fixture");
  assert.equal(report.generated_at, "2026-09-26T00:00:00.000Z");
  assert.equal(JSON.parse(readFileSync(join(out, "scenarios", "threshold-resume.output.json"), "utf8")).alerts.length, 0);
});
