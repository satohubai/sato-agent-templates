#!/usr/bin/env node
// The status job's second half: after update-status.mjs has recorded tonight's
// cells, decide what each template × framework needs and do it.
//
//   pinned red/error           → page: the job fails (after status is recorded)
//   any allowed upgrade        → bump PRs computed from upgrade-policy.json
//                                (scripts/lib/upgrade-policy.mjs), NOT from the
//                                latest lane's set: per template × framework ×
//                                class (dependencies | devDependencies), one
//                                PR on bump/<t>-<f>-deps|dev; an open one is
//                                updated in place, never duplicated. After a
//                                push, ci.yml is dispatched on the bump branch
//                                so the checks run on exactly what merges.
//   latest red, pinned green   → ONE issue, deduped by title. The package is
//                                named only when it is established: the
//                                one-package bisect (scripts/bisect-latest.mjs)
//                                reproduced the failure with that upgrade alone,
//                                or it is the only package that changed, or the
//                                drift drill injected it:
//                                  "upstream break: <pkg>@<v> breaks <t>/<f>"
//                                every single upgrade passed alone:
//                                  "upstream drift in <t>/<f>: a combination of newer versions fails <step>"
//                                bisect did not finish (time box, no bisect):
//                                  "upstream drift in <t>/<f>: newer versions fail <step> (not attributed)"
//   latest green               → closes any open break or drift issue for <t>/<f>
//
// decide() is pure over the cells and the open PR / issue lists; main() only
// reads them with gh and carries the actions out.
//
//   node scripts/latest-lane.mjs --status status.json --date YYYY-MM-DD [--dry-run] [--inject pkg@v]

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { peerRanges } from "./resolve-latest.mjs";
import { CLASSES, bumpActions, loadPolicy, planBumps, runtimeMajor } from "./lib/upgrade-policy.mjs";

export const BUMP_PREFIX = "bump/";
export const ISSUE_PREFIX = "upstream break: ";
export const DRIFT_PREFIX = "upstream drift in ";

export const pairId = (c) => `${c.template}/${c.framework}`;
export const issueSuffix = (c) => ` breaks ${pairId(c)}`;
export const issueTitle = (pkg, version, c) => `${ISSUE_PREFIX}${pkg}@${version}${issueSuffix(c)}`;
export const driftPrefix = (c) => `${DRIFT_PREFIX}${pairId(c)}: `;
export const isIssueFor = (title, c) => (title.startsWith(ISSUE_PREFIX) && title.endsWith(issueSuffix(c))) || title.startsWith(driftPrefix(c));

/**
 * Pure: the title for a red latest cell. Names a package only when that
 * package is established as the cause; never the alphabetically-first change.
 */
export function breakTitle({ pair, diff, attribution, inject, failingStep }) {
  const step = failingStep ?? "a check";
  if (inject) {
    const hit = diff.find((d) => d.name === inject.name);
    return issueTitle(inject.name, hit ? hit.to : inject.version, pair);
  }
  if (attribution?.kind === "single") return issueTitle(attribution.name, attribution.to, pair);
  if (attribution?.kind === "combination") return `${driftPrefix(pair)}a combination of newer versions fails ${step}`;
  if (!attribution && diff.length === 1) return issueTitle(diff[0].name, diff[0].to, pair);
  return `${driftPrefix(pair)}newer versions fail ${step} (not attributed)`;
}

/** Packages whose latest-lane version differs from the pinned one, sorted by name. */
export function versionDiff(pinned = {}, latest = {}, vendored = []) {
  const out = [];
  for (const name of Object.keys(latest).sort()) {
    if (vendored.includes(name)) continue;
    if (latest[name] && pinned[name] !== latest[name]) out.push({ name, from: pinned[name] ?? null, to: latest[name] });
  }
  return out;
}

/**
 * Pure. cells: status.json cells. Bump PRs are decided separately
 * (bumpActions in scripts/lib/upgrade-policy.mjs).
 * openIssues: [{number, title}]. vendored: {"t/f": [names]}. inject: {name, version}|null.
 * Only cells last run on `date` count, so a stale latest cell never acts.
 */
export function decide({ cells, openIssues = [], date, vendored = {}, inject = null }) {
  const pairs = new Map();
  for (const c of cells ?? []) {
    if (c.last_run !== date) continue;
    const p = pairs.get(pairId(c)) ?? { template: c.template, framework: c.framework };
    p[c.lane] = c;
    pairs.set(pairId(c), p);
  }
  const actions = [];
  for (const id of [...pairs.keys()].sort()) {
    const p = pairs.get(id);
    const { pinned, latest } = p;
    const base = { template: p.template, framework: p.framework };
    if (pinned && pinned.result !== "green") {
      actions.push({ type: "page", ...base, failing_step: pinned.failing_step });
    }
    if (!latest) continue;
    const diff = versionDiff(pinned?.resolved, latest.resolved, vendored[id] ?? []);
    if (latest.result === "green") {
      for (const i of openIssues) {
        if (isIssueFor(i.title, p)) actions.push({ type: "close_issue", ...base, number: i.number, title: i.title });
      }
    } else if (latest.result === "red" && pinned?.result === "green") {
      const attribution = latest.attribution ?? null;
      const title = breakTitle({ pair: p, diff, attribution, inject, failingStep: latest.failing_step });
      if (!openIssues.some((i) => i.title === title)) {
        actions.push({ type: "issue", ...base, title, failing_step: latest.failing_step, log_excerpt: latest.log_excerpt, versions: diff, attribution });
      }
    }
  }
  return actions;
}

export function bumpBody(a) {
  const rows = a.versions.map((v) => `| \`${v.name}\` | ${a.class} | ${v.from ?? "(new)"} | ${v.to} |`).join("\n");
  const held = (a.held ?? []).map((h) => `| \`${h.pkg}\` | ${h.class ?? ""} | ${h.pinned} | ${h.latest} | ${h.reason} |`).join("\n");
  const heldText = held
    ? `Held by the update policy (not in this PR):\n\n| package | class | pinned | newest published | reason |\n|---|---|---|---|---|\n${held}\n`
    : "Held by the update policy: nothing.\n";
  return `Update-policy bump for \`${a.template}/${a.framework}\`, class \`${a.class}\` (${a.class === "devDependencies" ? "tooling" : "runtime code"}).\n\nEach version is the highest published on registry.npmjs.org that \`upgrade-policy.json\` allows. It is not the latest lane's set: the latest lane tests newest-of-everything as an early warning, and this PR carries only what the policy permits.\n\n| package | class | pinned | bump to |\n|---|---|---|---|\n${rows}\n\n${heldText}\nThe status job dispatches \`ci.yml\` on this branch after every push, so the checks shown here ran on exactly this commit. Merge only when they are green.\n\nOpened by the nightly status job (scripts/latest-lane.mjs).\n`;
}

/** Pure: one paragraph on how (or whether) the cause was established. */
export function attributionText(a) {
  const at = a.attribution;
  const tried = (at?.trials ?? []).map((t) => `- \`${t.name}\` ${t.from ?? "(new)"} → ${t.to} alone: ${t.reproduced ? `fails \`${t.step}\`` : "passes"}`).join("\n");
  if (at?.kind === "single") return `Attribution: one-package bisect. With every other package at its pinned version, upgrading \`${at.name}\` from ${at.from ?? "(new)"} to ${at.to} alone fails \`${at.step}\`.\n\n${tried}`;
  if (at?.kind === "combination") return `Attribution: no single upgrade reproduces the failure. Each changed package was upgraded alone with every other package pinned, and each run passed, so the failure needs a combination of the newer versions.\n\n${tried}`;
  if (at?.kind === "inconclusive") return `Attribution: not established (${at.reason}).${tried ? `\n\n${tried}` : ""}`;
  if ((a.versions ?? []).length === 1) return `Attribution: only one package changed.`;
  return `Attribution: not established; no bisect result was recorded for this cell.`;
}

export function issueBody(a) {
  const rows = a.versions.map((v) => `| \`${v.name}\` | ${v.from ?? "(new)"} | ${v.to} |`).join("\n") || "| (no version change recorded) | | |";
  const log = (a.log_excerpt ?? "(no log captured)").slice(-6000).replace(/```/g, "'''");
  return `The latest lane for \`${a.template}/${a.framework}\` failed tonight while the pinned lane passed.\n\nFailing step: \`${a.failing_step ?? "unknown"}\`\n\n${attributionText(a)}\n\nEvery version that changed:\n\n| package | pinned | latest |\n|---|---|---|\n${rows}\n\n<details><summary>Log excerpt</summary>\n\n\`\`\`\n${log}\n\`\`\`\n</details>\n\nThe pinned versions are unaffected. This issue closes itself on the first night the latest lane passes again.\n\nOpened by the nightly status job (scripts/latest-lane.mjs).\n`;
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts });
}

function vendoredMap(cells) {
  const out = {};
  for (const c of cells) {
    try {
      const pkg = JSON.parse(readFileSync(join("templates", c.template, c.framework, "package.json"), "utf8"));
      out[pairId(c)] = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(([, s]) => String(s).startsWith("file:")).map(([n]) => n);
    } catch { /* template removed since */ }
  }
  return out;
}

/**
 * Rewrite the exact pins in sato.template.json's `template.upstream` block for
 * the bumped packages, leaving every other byte as it was. A bump that moved
 * package.json but not these pins would fail the template's own pinned-lane
 * test ("upstream pins match the lockfile") on its own PR.
 */
export function bumpUpstreamText(text, versions) {
  const start = text.indexOf('"upstream"');
  if (start < 0) return text;
  const open = text.indexOf("{", start);
  const close = text.indexOf("}", open);
  if (open < 0 || close < 0) return text;
  let block = text.slice(open, close + 1);
  for (const v of versions) {
    const key = JSON.stringify(v.name);
    const re = new RegExp(`(${key.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\s*:\\s*)"[^"]*"`);
    block = block.replace(re, `$1${JSON.stringify(v.to)}`);
  }
  return text.slice(0, open) + block + text.slice(close + 1);
}

/** The repo setting that lets GITHUB_TOKEN open pull requests. */
export const PR_PERMISSION_HINT =
  "Settings → Actions → General → Workflow permissions → \"Allow GitHub Actions to create and approve pull requests\"";

function applyBump(a) {
  const dir = join("templates", a.template, a.framework);
  sh("git", ["fetch", "--quiet", "origin", "main"]);
  sh("git", ["checkout", "-B", a.branch, "origin/main"]);
  const specs = a.versions.map((v) => `${v.name}@${v.to}`);
  sh("npm", ["install", ...specs, a.class === "devDependencies" ? "--save-dev" : "--save-prod", "--save-exact", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/"], { cwd: dir });
  sh("node", ["scripts/check-lock-registry.mjs", join(dir, "package-lock.json")]);
  const manifestPath = join(dir, "sato.template.json");
  writeFileSync(manifestPath, bumpUpstreamText(readFileSync(manifestPath, "utf8"), a.versions));
  sh("git", ["add", join(dir, "package.json"), join(dir, "package-lock.json"), manifestPath]);
  sh("git", ["-c", "user.name=Sato Hub", "-c", "user.email=satohub88@gmail.com", "commit", "-m", `deps(${a.template}/${a.framework}): ${a.class} per the update policy`]);
  const bodyFile = join(process.env.RUNNER_TEMP || ".", `bump-${a.template}-${a.framework}-${a.class}.md`);
  writeFileSync(bodyFile, bumpBody(a));
  if (a.mode === "update") {
    // Same contents already on the open PR: nothing to push, nothing to re-run.
    let same = false;
    try {
      sh("git", ["fetch", "--quiet", "origin", `+refs/heads/${a.branch}:refs/remotes/origin/${a.branch}`]);
      same = sh("git", ["rev-parse", "HEAD^{tree}"]).trim() === sh("git", ["rev-parse", `origin/${a.branch}^{tree}`]).trim();
    } catch { same = false; }
    if (same) { console.log(`bump ${a.branch}: open PR #${a.number} already carries these versions`); sh("git", ["checkout", "--detach", "origin/main"]); return; }
    // bump/ branches are ours and rebuilt from origin/main every run.
    sh("git", ["push", "--force", "origin", `HEAD:refs/heads/${a.branch}`]);
    sh("gh", ["pr", "edit", String(a.number), "--body-file", bodyFile]);
  } else {
    sh("git", ["push", "--force", "origin", `HEAD:refs/heads/${a.branch}`]);
    try {
      sh("gh", ["pr", "create", "--base", "main", "--head", a.branch, "--title", `deps(${a.template}/${a.framework}): ${a.class} per the update policy`, "--body-file", bodyFile]);
    } catch (e) {
      // Leave nothing behind: a branch with no pull request is noise, and the
      // next night rebuilds it. The usual cause is the repo setting.
      try { sh("git", ["push", "origin", "--delete", a.branch]); } catch { /* already gone */ }
      throw new Error(`pull request not opened (${String(e.message).split("\n")[0]}); branch removed. If Actions may not open PRs here, enable: ${PR_PERMISSION_HINT}`);
    }
  }
  // A push by GITHUB_TOKEN triggers no pull_request workflow; a
  // workflow_dispatch does, and its checks attach to the bump commit.
  sh("gh", ["workflow", "run", "ci.yml", "--ref", a.branch, "-f", `ref=${a.branch}`]);
  sh("git", ["checkout", "--detach", "origin/main"]);
}

function npmVersions(spec, field = "versions") {
  try {
    const out = execFileSync("npm", ["view", spec, field, "--json", "--registry=https://registry.npmjs.org/"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 }).trim();
    const v = out ? JSON.parse(out) : [];
    return Array.isArray(v) ? v : [v];
  } catch { return []; }
}

/** Reads each template run tonight and plans its bumps under the policy. */
function planAll(cells, date, policy) {
  const pairs = [...new Map(cells.filter((c) => c.last_run === date).map((c) => [pairId(c), { template: c.template, framework: c.framework }])).values()];
  const cache = new Map();
  const plans = [];
  for (const p of pairs) {
    const dir = join("templates", p.template, p.framework);
    let pkg, manifest;
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      manifest = JSON.parse(readFileSync(join(dir, "sato.template.json"), "utf8"));
    } catch { continue; }
    let lock = {};
    try { lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")); } catch { /* no lockfile: no framework constraints */ }
    const direct = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const registry = {}, constraints = {};
    for (const cls of CLASSES) for (const [name, spec] of Object.entries(pkg[cls] ?? {})) {
      if (String(spec).startsWith("file:")) continue;
      if (!cache.has(name)) cache.set(name, npmVersions(name));
      registry[name] = cache.get(name);
      constraints[name] = peerRanges(lock, name, direct).map((r) => {
        const key = `${name}@${r.range}`;
        if (!cache.has(key)) cache.set(key, npmVersions(key, "version"));
        return { ...r, versions: cache.get(key) };
      });
    }
    plans.push({ ...p, plan: planBumps({ pkg, registry, policy, runtime: runtimeMajor(manifest), constraints }) });
  }
  return plans;
}

function arg(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

export function main(argv = process.argv.slice(2)) {
  const status = JSON.parse(readFileSync(arg(argv, "--status", "status.json"), "utf8"));
  const date = arg(argv, "--date", new Date().toISOString().slice(0, 10));
  const dry = argv.includes("--dry-run");
  const injectRaw = arg(argv, "--inject", process.env.INJECT_DRIFT || "");
  const at = injectRaw.lastIndexOf("@");
  const inject = injectRaw && at > 0 ? { name: injectRaw.slice(0, at), version: injectRaw.slice(at + 1) } : null;
  const openPrs = dry ? [] : JSON.parse(sh("gh", ["pr", "list", "--state", "open", "--limit", "200", "--json", "number,headRefName"]));
  const openIssues = dry ? [] : JSON.parse(sh("gh", ["issue", "list", "--state", "open", "--limit", "200", "--search", `upstream in:title`, "--json", "number,title"]));
  const actions = decide({ cells: status.cells, openIssues, date, vendored: vendoredMap(status.cells), inject });
  const policy = loadPolicy(arg(argv, "--policy", "upgrade-policy.json"));
  actions.push(...bumpActions({ plans: dry && argv.includes("--offline") ? [] : planAll(status.cells, date, policy), openPrs }));
  let page = false;
  for (const a of actions) {
    console.log(`${a.type} ${a.template}/${a.framework}${a.title ? `: ${a.title}` : ""}${a.branch ? `: ${a.branch} (${a.mode}${a.number ? ` #${a.number}` : ""}) ${a.versions.map((v) => `${v.name} ${v.from}→${v.to}`).join(", ")}` : ""}`);
    if (a.type === "page") { page = true; continue; }
    if (dry) continue;
    try {
      if (a.type === "bump") applyBump(a);
      else if (a.type === "issue") {
        const f = join(process.env.RUNNER_TEMP || ".", `issue-${a.template}-${a.framework}.md`);
        writeFileSync(f, issueBody(a));
        sh("gh", ["issue", "create", "--title", a.title, "--body-file", f]);
      } else if (a.type === "close_issue") {
        sh("gh", ["issue", "close", String(a.number), "--comment", `The latest lane for ${a.template}/${a.framework} passed tonight's checks (${date}). Closing.`]);
      }
    } catch (e) {
      console.error(`::warning::${a.type} ${a.template}/${a.framework} failed: ${e.message}`);
    }
  }
  if (!actions.length) console.log("latest lane: nothing to do");
  if (page) { console.error("::error::a pinned cell is not green; status recorded, failing the job"); process.exitCode = 1; }
  return actions;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
