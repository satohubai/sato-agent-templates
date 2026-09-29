#!/usr/bin/env node
// The weekly journey's facts, read off what the CLI and doctor printed.
//
//   node scripts/journey-info.mjs create <create.json> [--github-output <file>]
//   node scripts/journey-info.mjs doctor <doctor.json> --out <info.json>
//
// `create`: which template the create API planned (the cell's template), or,
// when the CLI stopped, its error code and the HTTP status it named. A refusal
// or a missing /api/create is recorded as it was answered, never guessed.
// `doctor`: doctor must print parseable JSON with ok:true. Template drift is
// recorded as info (state + the changes it listed), never as a failure.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
export const NO_TEMPLATE = "unplanned";

function readJson(path) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8").trim();
  // The CLI's --json output is one object; take the last JSON line if npm printed noise before it.
  for (const candidate of [text, ...text.split("\n").reverse()]) {
    try { return JSON.parse(candidate); } catch { /* next */ }
  }
  return null;
}

/** Pure: the create CLI's --json output → the cell's template + create info. */
export function createInfo(out) {
  if (out && out.ok === true && out.template && SLUG.test(String(out.template.id ?? ""))) {
    return {
      template: out.template.id,
      create: { ok: true, template_version: out.template.version ?? null, digest: out.template.digest ?? null },
    };
  }
  const message = String(out?.message ?? out?.error?.message ?? (out ? "" : "no JSON output"));
  const http = /HTTP (\d{3})/.exec(message)?.[1];
  return {
    template: NO_TEMPLATE,
    create: {
      ok: false,
      error: String(out?.error?.code ?? out?.error ?? out?.code ?? "no_output").slice(0, 80),
      rule: out?.rule ?? out?.error?.rule ?? null,
      http_status: http ? Number(http) : null,
      message: message.slice(0, 400),
    },
  };
}

/** Pure: doctor --json → { ok, drift }. ok is false only when doctor gave no usable answer. */
export function doctorInfo(out) {
  if (!out || out.ok !== true || !out.result) return { ok: false, drift: null };
  const d = out.result.drift ?? null;
  return {
    ok: true,
    drift: d ? {
      state: String(d.state ?? "unknown"),
      changes: Array.isArray(d.changes) ? d.changes.slice(0, 20) : [],
      latest_version: d.template?.latest_version ?? null,
      pinned_version: d.template?.pinned_version ?? null,
    } : null,
  };
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv = process.argv.slice(2)) {
  const [cmd, path] = argv;
  if (cmd === "create") {
    const info = createInfo(readJson(path));
    const gh = arg(argv, "--github-output");
    if (gh) appendFileSync(gh, `template=${info.template}\n`);
    writeFileSync(arg(argv, "--out") ?? "create-info.json", JSON.stringify(info.create, null, 2) + "\n");
    console.log(info.create.ok ? `create: planned ${info.template}` : `create: ${info.create.error}${info.create.http_status ? ` (HTTP ${info.create.http_status})` : ""}`);
    return info.create.ok ? 0 : 1;
  }
  if (cmd === "doctor") {
    const info = doctorInfo(readJson(path));
    writeFileSync(arg(argv, "--out") ?? "doctor-info.json", JSON.stringify(info, null, 2) + "\n");
    console.log(info.ok ? `doctor: answered; drift ${info.drift?.state ?? "not reported"}, ${info.drift?.changes.length ?? 0} change(s) (info only)` : "doctor: no usable answer");
    return info.ok ? 0 : 1;
  }
  console.error("usage: journey-info.mjs create|doctor <file>");
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main());
