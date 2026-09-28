#!/usr/bin/env node
// Latest lane, after a red cell: find WHICH upstream upgrade broke it.
//
// For every package whose latest-lane version differs from the pinned one
// (vendored packages never do), this restores the pinned package.json and
// lockfile, upgrades exactly that ONE package, and re-runs the cell's steps
// from install up to the step that failed. The first single upgrade that fails
// again is the attribution. When every single upgrade passes, the break needs a
// combination of newer versions, and the issue says so instead of naming one.
// When the time box runs out first, nothing is attributed.
//
//   node scripts/bisect-latest.mjs            (cwd = the template directory)
//
// Env: FAILING_STEP or STEPS_JSON + STEP_ORDER (to find it), LOG_DIR (writes
// attribution.json there), BISECT_BUDGET_S (default 600), PINNED_REF (default
// HEAD). The latest-lane package.json and lockfile are put back when it ends,
// so the result collected afterwards still records the latest versions.

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const REGISTRY = "https://registry.npmjs.org/";

/** The commands each step runs, in cell order. Steps not listed cannot be re-run alone. */
export const STEP_COMMANDS = {
  install: [
    ["node", ["$ROOT/scripts/check-lock-registry.mjs", "package-lock.json"]],
    ["npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${REGISTRY}`]],
  ],
  typecheck: [["npm", ["run", "typecheck"]]],
  fixture_run: [["npm", ["start", "--", "--mode", "fixture"]]],
  test: [["npm", ["test"]]],
  fork_check: [["npm", ["run", "fork-check"]]],
};
const RERUN_ORDER = ["install", "typecheck", "fixture_run", "test", "fork_check"];

/** Pure: the steps to re-run to reproduce a failure at `failing`, or null if it cannot be re-run. */
export function stepsUpTo(failing, hasForkCheck = true) {
  const i = RERUN_ORDER.indexOf(failing);
  if (i < 0) return null;
  return RERUN_ORDER.slice(0, i + 1).filter((s) => hasForkCheck || s !== "fork_check");
}

/** Pure: pinned vs latest direct-dependency versions → the single upgrades to try, by name. */
export function candidates(pinnedPkg, latestPkg) {
  const out = [];
  for (const group of ["dependencies", "devDependencies"]) {
    for (const [name, to] of Object.entries(latestPkg[group] ?? {})) {
      const from = pinnedPkg[group]?.[name] ?? pinnedPkg.dependencies?.[name] ?? pinnedPkg.devDependencies?.[name] ?? null;
      if (String(to).startsWith("file:") || from === to) continue;
      out.push({ name, from, to, dev: group === "devDependencies" });
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Pure: the tried single upgrades → the attribution.
 * trials: [{name, from, to, reproduced: bool, step?, failed_other?}] in the order tried.
 * A trial reproduces the failure only when it fails at the SAME step the cell
 * failed at. A trial that fails somewhere else (e.g. its own install hits
 * ERESOLVE against a pinned peer) carries `failed_other: <step>` and is not a
 * reproduction.
 *   single       — the first single upgrade that reproduced the failure
 *   combination  — every changed package was tried alone, each passed, none reproduced it
 *   inconclusive — the time box (or an error) stopped it, or a trial failed at another step
 */
export function reproduces(t, failingStep) {
  return t.reproduced === true && !t.failed_other && (t.step ?? failingStep) === failingStep;
}

export function attribute({ failingStep, changes, trials, reason = null }) {
  const hit = trials.find((t) => reproduces(t, failingStep));
  const base = { failing_step: failingStep, changes, trials };
  if (hit) return { kind: "single", name: hit.name, from: hit.from, to: hit.to, step: failingStep, ...base };
  const other = trials.filter((t) => t.failed_other || (t.reproduced === true && !reproduces(t, failingStep)));
  if (other.length) {
    const what = other.map((t) => `${t.name}@${t.to} alone failed at ${t.failed_other ?? t.step}`).join("; ");
    return { kind: "inconclusive", reason: `${what}, not at the failing step (${failingStep ?? "unknown"})`, ...base };
  }
  if (changes.length && trials.length === changes.length && trials.every((t) => t.reproduced === false)) return { kind: "combination", ...base };
  return { kind: "inconclusive", reason: reason ?? "not every changed package was tried", ...base };
}

export function failingStepFrom(env) {
  if (env.FAILING_STEP) return env.FAILING_STEP;
  const steps = JSON.parse(env.STEPS_JSON || "{}");
  const order = (env.STEP_ORDER || "").split(",").map((s) => s.trim()).filter(Boolean);
  return order.find((id) => steps[id]?.outcome === "failure") ?? null;
}

function run(cmd, args, { root, deadline, logFile }) {
  const left = Math.max(1, deadline - Date.now());
  const r = spawnSync(cmd, args.map((a) => a.replace("$ROOT", root)), { encoding: "utf8", timeout: left, env: process.env, maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(logFile, `$ ${cmd} ${args.join(" ")}\n${r.stdout ?? ""}${r.stderr ?? ""}\n`, { flag: "a" });
  if (r.error?.code === "ETIMEDOUT") throw new Error("time box reached");
  return r.status === 0;
}

export function main(env = process.env) {
  const logDir = env.LOG_DIR || ".";
  const out = join(logDir, "attribution.json");
  const logFile = join(logDir, "bisect.log");
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const rel = relative(root, process.cwd());
  const ref = env.PINNED_REF || "HEAD";
  const failingStep = failingStepFrom(env);
  const latestPkg = JSON.parse(readFileSync("package.json", "utf8"));
  const pinnedPkgText = execFileSync("git", ["show", `${ref}:${rel}/package.json`], { encoding: "utf8" });
  const pinnedLockText = execFileSync("git", ["show", `${ref}:${rel}/package-lock.json`], { encoding: "utf8" });
  const pinnedPkg = JSON.parse(pinnedPkgText);
  const changes = candidates(pinnedPkg, latestPkg);
  const steps = stepsUpTo(failingStep, Boolean(latestPkg.scripts?.["fork-check"]));
  const trials = [];
  let reason = null;

  if (!steps) {
    reason = `the failing step (${failingStep ?? "unknown"}) cannot be re-run on its own`;
  } else {
    const budget = Number(env.BISECT_BUDGET_S || 600) * 1000;
    const deadline = Date.now() + budget;
    copyFileSync("package.json", join(logDir, "latest.package.json"));
    copyFileSync("package-lock.json", join(logDir, "latest.package-lock.json"));
    try {
      for (const c of changes) {
        if (Date.now() >= deadline) { reason = "time box reached"; break; }
        writeFileSync("package.json", pinnedPkgText);
        writeFileSync("package-lock.json", pinnedLockText);
        writeFileSync(logFile, `\n=== ${c.name}: ${c.from} -> ${c.to} (all else pinned) ===\n`, { flag: "a" });
        const ok = run("npm", ["install", `${c.name}@${c.to}`, c.dev ? "--save-dev" : "--save-prod", "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${REGISTRY}`], { root, deadline, logFile });
        let failedAt = ok ? null : "install";
        for (const step of ok ? steps : []) {
          const pass = STEP_COMMANDS[step].every(([cmd, args]) => run(cmd, args, { root, deadline, logFile }));
          if (!pass) { failedAt = step; break; }
        }
        const reproduced = failedAt !== null && failedAt === failingStep;
        const trial = { name: c.name, from: c.from, to: c.to, reproduced, step: failedAt };
        if (failedAt !== null && !reproduced) trial.failed_other = failedAt;
        trials.push(trial);
        console.log(`bisect: ${c.name}@${c.to} alone → ${failedAt ? `fails ${failedAt}${reproduced ? "" : ` (not the failing step ${failingStep})`}` : "passes"}`);
        if (reproduced) break;
      }
    } catch (e) {
      reason = e.message;
    } finally {
      copyFileSync(join(logDir, "latest.package.json"), "package.json");
      copyFileSync(join(logDir, "latest.package-lock.json"), "package-lock.json");
    }
  }
  const a = attribute({ failingStep, changes: changes.map(({ name, from, to }) => ({ name, from, to })), trials, reason });
  writeFileSync(out, JSON.stringify(a, null, 2) + "\n");
  console.log(`attribution: ${a.kind}${a.kind === "single" ? ` ${a.name}@${a.to}` : ""}${a.reason ? ` (${a.reason})` : ""}`);
  return a;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (!existsSync("package.json")) { console.error("run from a template directory"); process.exit(2); }
  main();
}
