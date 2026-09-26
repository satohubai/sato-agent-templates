#!/usr/bin/env node
// Writes one cell's result JSON at the end of a verify job.
//
// Inputs (env): TEMPLATE, FRAMEWORK, LANE, STEPS_JSON (the job's
// `toJSON(steps)`), STEP_ORDER (comma list of step ids in run order),
// LOG_DIR (where each step tee'd its output as <id>.log), TEMPLATE_DIR, OUT.
// The failing step is the first one in STEP_ORDER whose outcome is failure;
// its log excerpt is the last 40 lines of that step's log.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const env = process.env;
const steps = JSON.parse(env.STEPS_JSON || "{}");
const order = (env.STEP_ORDER || "").split(",").map((s) => s.trim()).filter(Boolean);
const failing = order.find((id) => steps[id]?.outcome === "failure") ?? null;
const anyMissing = order.some((id) => !steps[id] || steps[id].outcome === "skipped" || steps[id].outcome === "cancelled");

let log_excerpt = null;
if (failing) {
  const f = join(env.LOG_DIR || ".", `${failing}.log`);
  log_excerpt = existsSync(f) ? readFileSync(f, "utf8").split("\n").slice(-40).join("\n") : "(no log captured for this step)";
}

const resolved = {};
const lockPath = join(env.TEMPLATE_DIR || ".", "package-lock.json");
const pkgPath = join(env.TEMPLATE_DIR || ".", "package.json");
if (existsSync(lockPath) && existsSync(pkgPath)) {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).sort()) {
    const v = lock.packages?.[`node_modules/${name}`]?.version;
    if (v) resolved[name] = v;
  }
}

const result = failing ? "red" : anyMissing ? "error" : "green";
const out = {
  template: env.TEMPLATE,
  framework: env.FRAMEWORK,
  lane: env.LANE,
  result,
  failing_step: failing ?? (anyMissing ? "incomplete" : null),
  log_excerpt,
  resolved,
};
writeFileSync(env.OUT || "result.json", JSON.stringify(out, null, 2) + "\n");
console.log(`${out.template}/${out.framework}/${out.lane}: ${result}${out.failing_step ? ` (${out.failing_step})` : ""}`);
