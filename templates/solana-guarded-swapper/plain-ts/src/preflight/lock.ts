// Reads package.json + package-lock.json and picks the packages the preflight
// checks. Pure: files are passed in as parsed JSON.
//
// Default set: every direct dependency, plus every locked production package on
// the watch list in receipts.config.json (the packages that handle keys or
// build and sign transactions). `all` takes the whole production closure.

import type { Subject } from "./types.js";

type LockEntry = {
  name?: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  dev?: boolean;
  link?: boolean;
};

export type LockFile = { lockfileVersion?: number; packages?: Record<string, LockEntry> };
export type PackageJson = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

export class LockError extends Error {}

/** node_modules/a/node_modules/@s/b -> @s/b */
export function nameFromLockPath(path: string): string {
  const i = path.lastIndexOf("node_modules/");
  return i === -1 ? path : path.slice(i + "node_modules/".length);
}

/** "@solana/*" matches by prefix, anything else by exact name. */
export function matchesWatch(name: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));
}

export function subjectId(name: string): string {
  return `npm:${name}`;
}

export type SelectOptions = { watch: readonly string[]; all: boolean; only?: readonly string[] };

export function selectSubjects(pkg: PackageJson, lock: LockFile, opts: SelectOptions): Subject[] {
  if (!lock.packages || typeof lock.packages !== "object") throw new LockError("package-lock.json has no packages map (lockfileVersion 2 or 3 is needed)");
  const direct = new Set(Object.keys(pkg.dependencies ?? {}));
  const out = new Map<string, Subject>();
  for (const [path, e] of Object.entries(lock.packages)) {
    if (!path || e.link || e.dev === true) continue;
    if (typeof e.version !== "string") continue;
    const name = e.name ?? nameFromLockPath(path);
    // Only the copy the project resolves to is "direct"; a nested duplicate is the same package at another version.
    const isDirect = direct.has(name) && path === `node_modules/${name}`;
    const reason: Subject["reason"] | null = isDirect ? "direct" : matchesWatch(name, opts.watch) ? "watch" : opts.all ? "all" : null;
    if (!reason) continue;
    if (opts.only && opts.only.length > 0 && !opts.only.includes(name)) continue;
    const key = `${name}@${e.version}`;
    const prior = out.get(key);
    if (prior) continue;
    out.set(key, {
      name,
      version: e.version,
      subject_id: subjectId(name),
      reason,
      resolved: e.resolved ?? null,
      integrity: e.integrity ?? null,
      lock_path: path,
    });
  }
  const rank = { direct: 0, watch: 1, all: 2 } as const;
  return [...out.values()].sort((a, b) => rank[a.reason] - rank[b.reason] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
