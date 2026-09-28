#!/usr/bin/env node
// The status job's second half: after update-status.mjs has recorded tonight's
// cells, decide what each template × framework needs and do it.
//
//   pinned red/error           → page: the job fails (after status is recorded)
//   latest green, pinned green,
//     pinned behind            → ONE bump PR (branch bump/<t>-<f>-<date>),
//                                never a second open one for the same pair
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

export const BUMP_PREFIX = "bump/";
export const ISSUE_PREFIX = "upstream break: ";
export const DRIFT_PREFIX = "upstream drift in ";

export const pairId = (c) => `${c.template}/${c.framework}`;
export const bumpBranchPrefix = (c) => `${BUMP_PREFIX}${c.template}-${c.framework}-`;
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
 * Pure. cells: status.json cells. openPrs: [{number, headRefName}].
 * openIssues: [{number, title}]. vendored: {"t/f": [names]}. inject: {name, version}|null.
 * Only cells last run on `date` count, so a stale latest cell never acts.
 */
export function decide({ cells, openPrs = [], openIssues = [], date, vendored = {}, inject = null }) {
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
      if (pinned?.result === "green" && diff.length) {
        const dup = openPrs.find((pr) => pr.headRefName.startsWith(bumpBranchPrefix(p)));
        if (!dup) actions.push({ type: "bump", ...base, branch: `${bumpBranchPrefix(p)}${date}`, versions: diff });
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
  const rows = a.versions.map((v) => `| \`${v.name}\` | ${v.from ?? "(new)"} | ${v.to} |`).join("\n");
  return `The latest lane for \`${a.template}/${a.framework}\` passed tonight's checks with newer upstream versions than the pinned lane.\n\n| package | pinned | latest (passed tonight's checks) |\n|---|---|---|\n${rows}\n\nThis PR moves the exact pins and the lockfile to those versions. The pinned lane re-verifies them on this PR.\n\nOpened by the nightly status job (scripts/latest-lane.mjs).\n`;
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

function applyBump(a) {
  const dir = join("templates", a.template, a.framework);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  sh("git", ["checkout", "-B", a.branch, "origin/main"]);
  const prod = a.versions.filter((v) => !pkg.devDependencies?.[v.name]).map((v) => `${v.name}@${v.to}`);
  const dev = a.versions.filter((v) => pkg.devDependencies?.[v.name]).map((v) => `${v.name}@${v.to}`);
  for (const [specs, flag] of [[prod, "--save-prod"], [dev, "--save-dev"]]) {
    if (!specs.length) continue;
    sh("npm", ["install", ...specs, flag, "--save-exact", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/"], { cwd: dir });
  }
  sh("node", ["scripts/check-lock-registry.mjs", join(dir, "package-lock.json")]);
  sh("git", ["add", join(dir, "package.json"), join(dir, "package-lock.json")]);
  sh("git", ["-c", "user.name=Sato Hub", "-c", "user.email=satohub88@gmail.com", "commit", "-m", `deps(${a.template}/${a.framework}): bump to versions that passed the latest lane`]);
  sh("git", ["push", "origin", `HEAD:refs/heads/${a.branch}`]);
  const bodyFile = join(process.env.RUNNER_TEMP || ".", `bump-${a.template}-${a.framework}.md`);
  writeFileSync(bodyFile, bumpBody(a));
  sh("gh", ["pr", "create", "--base", "main", "--head", a.branch, "--title", `deps(${a.template}/${a.framework}): bump pins to the latest green versions`, "--body-file", bodyFile]);
  sh("git", ["checkout", "--detach", "origin/main"]);
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
  const actions = decide({ cells: status.cells, openPrs, openIssues, date, vendored: vendoredMap(status.cells), inject });
  let page = false;
  for (const a of actions) {
    console.log(`${a.type} ${a.template}/${a.framework}${a.title ? `: ${a.title}` : ""}${a.branch ? `: ${a.branch}` : ""}`);
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
