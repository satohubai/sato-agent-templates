// The update policy (upgrade-policy.json, schema sato.upgrade-policy/v1): which
// published versions a bump PR may move a template's pins to. Pure functions;
// the latest lane still tests newest-of-everything and only REPORTS what this
// policy holds back.
//
//   (a) @types/node follows the template's runtime major (sato.template.json
//       runtime.version) and never goes above it;
//   (b) no major upgrade of any package unless it is listed in allow_major;
//   (c) for 0.x a change of the minor counts as a major (0.3 → 0.4), and for
//       0.0.x a change of the patch does (0.0.3 → 0.0.4);
//   (d) bump PRs are split by class: dependencies (runtime code) and
//       devDependencies (tooling), one PR each per template × framework;
//   (e) vendored file: dependencies (the kit tarball) are never bumped.

import { readFileSync } from "node:fs";

export const POLICY_SCHEMA = "sato.upgrade-policy/v1";
export const CLASSES = ["dependencies", "devDependencies"];
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function validatePolicy(p) {
  if (p?.schema !== POLICY_SCHEMA) throw new Error(`upgrade-policy.json: schema must be ${POLICY_SCHEMA}`);
  if (!Array.isArray(p.allow_major) || p.allow_major.some((n) => typeof n !== "string")) throw new Error("upgrade-policy.json: allow_major must be a list of package names");
  return p;
}

export function loadPolicy(path = "upgrade-policy.json") {
  return validatePolicy(JSON.parse(readFileSync(path, "utf8")));
}

export function parseSemver(v) {
  const m = SEMVER_RE.exec(String(v ?? ""));
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null };
}

export function compareSemver(a, b) {
  const x = parseSemver(a), y = parseSemver(b);
  for (const k of ["major", "minor", "patch"]) if (x[k] !== y[k]) return x[k] - y[k];
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** The part of a version whose change is a breaking change: "5", "0.3", "0.0.4". */
export function breakingLine(v) {
  const s = parseSemver(v);
  if (!s) return null;
  if (s.major > 0) return String(s.major);
  if (s.minor > 0) return `0.${s.minor}`;
  return `0.0.${s.patch}`;
}

/** The runtime major a template declares: "22" from runtime.version "22" or "22.4". */
export function runtimeMajor(manifest) {
  const m = /^(\d+)/.exec(String(manifest?.runtime?.version ?? ""));
  return m ? +m[1] : null;
}

/**
 * Pure: why `candidate` is outside the policy for `name` pinned at `pinned`,
 * or null when it is allowed.
 */
export function heldReason({ name, pinned, candidate, policy, runtime }) {
  const c = parseSemver(candidate), p = parseSemver(pinned);
  if (!c || !p) return "not a plain semver version";
  if (name === "@types/node" && policy.types_node_follows_runtime !== false && runtime != null) {
    if (c.major !== runtime) return `@types/node follows the template's runtime major (Node ${runtime}); ${candidate} is for Node ${c.major}`;
  }
  if ((policy.allow_major ?? []).includes(name)) return null;
  const from = breakingLine(pinned), to = breakingLine(candidate);
  if (from !== to) {
    if (p.major === 0 && policy.zero_minor_is_major !== false) return `0.x change ${from} → ${to} counts as a major; ${name} is not in allow_major`;
    if (p.major !== c.major) return `major upgrade ${p.major} → ${c.major}; ${name} is not in allow_major`;
  }
  return null;
}

/**
 * Pure: the highest published stable version the policy allows, newer than
 * `pinned`; null when there is none. Prereleases never count.
 */
export function allowedTarget({ name, pinned, versions, policy, runtime }) {
  let best = null;
  for (const v of versions ?? []) {
    const s = parseSemver(v);
    if (!s || s.pre) continue;
    if (compareSemver(v, pinned) <= 0) continue;
    if (heldReason({ name, pinned, candidate: v, policy, runtime })) continue;
    if (!best || compareSemver(v, best) > 0) best = v;
  }
  return best;
}

/** The newest stable published version, or null. */
export function newestStable(versions) {
  let best = null;
  for (const v of versions ?? []) {
    const s = parseSemver(v);
    if (s && !s.pre && (!best || compareSemver(v, best) > 0)) best = v;
  }
  return best;
}

/**
 * Pure. pkg: the template's package.json; registry: {name: [published versions]}.
 * Returns the bump set per class and every newer version the policy holds back.
 * Vendored (file:) dependencies are skipped entirely.
 */
export function planBumps({ pkg, registry, policy, runtime, constraints = {} }) {
  const out = { dependencies: [], devDependencies: [], held: [] };
  for (const cls of CLASSES) {
    for (const name of Object.keys(pkg?.[cls] ?? {}).sort()) {
      const pinned = String(pkg[cls][name]);
      if (pinned.startsWith("file:")) continue;
      if (!parseSemver(pinned)) continue;
      const published = registry[name] ?? [];
      // The framework rule (as in resolve-latest.mjs): a peer range on it from
      // the resolved tree, or a dependency range from another direct
      // dependency, caps it too. Each constraint carries the versions its
      // range accepts.
      const cons = constraints[name] ?? [];
      const versions = published.filter((v) => cons.every((c) => c.versions.includes(v)));
      const to = allowedTarget({ name, pinned, versions, policy, runtime });
      if (to) out[cls].push({ name, class: cls, from: pinned, to });
      const newest = newestStable(published);
      if (newest && compareSemver(newest, to ?? pinned) > 0) {
        const policyReason = heldReason({ name, pinned, candidate: newest, policy, runtime });
        const blockers = cons.filter((c) => !c.versions.includes(newest)).map((c) => `${c.from} wants ${c.range}`);
        const reason = policyReason ?? (blockers.length ? `framework rule: ${blockers.join("; ")}` : null);
        if (reason) out.held.push({ pkg: name, class: cls, pinned, latest: newest, reason });
      }
    }
  }
  return out;
}

/**
 * Pure: the "held" list for a latest-lane cell. pinned: the template's
 * package.json; resolved: the versions the latest lane installed.
 */
export function heldInLatest({ pkg, resolved, policy, runtime }) {
  const held = [];
  for (const cls of CLASSES) {
    for (const name of Object.keys(pkg?.[cls] ?? {}).sort()) {
      const pinned = String(pkg[cls][name]);
      if (pinned.startsWith("file:") || !parseSemver(pinned)) continue;
      const latest = resolved?.[name];
      if (!latest || latest === pinned || !parseSemver(latest) || compareSemver(latest, pinned) <= 0) continue;
      const reason = heldReason({ name, pinned, candidate: latest, policy, runtime });
      if (reason) held.push({ pkg: name, pinned, latest, reason });
    }
  }
  return held;
}

export const bumpBranch = (t, f, cls) => `bump/${t}-${f}-${cls === "devDependencies" ? "dev" : "deps"}`;

/**
 * Pure. plans: [{template, framework, plan}]. openPrs: [{number, headRefName}].
 * One action per template × framework × class with an allowed change: "open"
 * a PR, or "update" the branch of the one already open (never a second PR).
 */
export function bumpActions({ plans, openPrs = [] }) {
  const out = [];
  for (const { template, framework, plan } of plans) {
    for (const cls of CLASSES) {
      const changes = plan[cls] ?? [];
      if (!changes.length) continue;
      const branch = bumpBranch(template, framework, cls);
      const pr = openPrs.find((p) => p.headRefName === branch);
      out.push({ type: "bump", mode: pr ? "update" : "open", number: pr?.number ?? null, template, framework, class: cls, branch, versions: changes, held: plan.held ?? [] });
    }
  }
  return out;
}
