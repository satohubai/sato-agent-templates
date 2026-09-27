#!/usr/bin/env node
// Runs tonight's checks on every action in scripts/actions-catalog.mjs and
// writes one result file per action for update-actions-status.mjs to fold in.
//
//   node scripts/check-actions.mjs --out <dir> [--rpc http://127.0.0.1:8547]
//     [--work <dir>] [--only <id,id>]
//
// Per action: (a) conformance — one read-only call (a fork read at the pinned
// block, or a public read; never a write, never a key); (b) schema lint —
// portable rules plus host facts; (c) custody — Sato Check's answers for the
// source, as returned; (d) the sha256 of the tool description (the updater
// compares it with last night's).
//
// Installs come from registry.npmjs.org only, with install scripts off, and
// the lockfile is checked afterwards. Third-party code runs in child processes
// whose environment is PATH and HOME only, each inside a time box, and is
// killed (with its process group) when the box closes.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ACTIONS, SOURCES } from "./actions-catalog.mjs";
import { fetchCustody } from "./lib/custody.mjs";
import { lintSkill, lintTool, schemaLintCell } from "./lib/host-lint.mjs";
import { parseFrontmatter, skillConformance } from "./lib/skill.mjs";
import { bareEnv, startServer } from "./lib/stdio-mcp.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UA = "SatoHub-templates-ci/1.0";
export const TIME = { install: 300_000, start: 60_000, call: 60_000, library: 240_000, fetch: 30_000 };

export function sha256(s) {
  return `sha256:${createHash("sha256").update(String(s)).digest("hex")}`;
}

function withTimeout(p, ms, step) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(`timed out after ${ms / 1000}s`), { step: "timeout", during: step })), ms); })]).finally(() => clearTimeout(t));
}

function run(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((res) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err = (err + c).slice(-4000); });
    const t = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }, timeoutMs);
    child.on("close", (code, signal) => { clearTimeout(t); res({ code, signal, out, err }); });
    child.on("error", (e) => { clearTimeout(t); res({ code: -1, signal: null, out, err: String(e.message) }); });
  });
}

// ── install ──────────────────────────────────────────────────────────────────

function lockOutsideRegistry(lock) {
  const bad = [];
  for (const [path, p] of Object.entries(lock.packages ?? {})) {
    if (!path || p.link || !p.resolved) continue;
    if (p.resolved.startsWith("https://registry.npmjs.org/") || p.resolved.startsWith("file:vendor/")) continue;
    bad.push(`${path} -> ${p.resolved}`);
  }
  return bad;
}

async function install(srcId, src, work) {
  const dir = join(work, srcId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `sato-status-${srcId}`, private: true, type: "module" }, null, 2));
  if (src.vendor) {
    mkdirSync(join(dir, "vendor"), { recursive: true });
    copyFileSync(join(ROOT, src.vendor), join(dir, "vendor", src.vendor.split("/").pop()));
  }
  const env = { ...bareEnv(), npm_config_registry: "https://registry.npmjs.org/", npm_config_ignore_scripts: "true", npm_config_update_notifier: "false" };
  const r = await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/", ...src.install], { cwd: dir, env, timeoutMs: TIME.install });
  if (r.code !== 0) return { ok: false, dir, step: "install", detail: (r.err || r.out).split("\n").slice(-12).join("\n") || `npm exited ${r.code ?? r.signal}` };
  const bad = lockOutsideRegistry(JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")));
  if (bad.length) return { ok: false, dir, step: "install", detail: `resolved outside the npm registry: ${bad.slice(0, 5).join(", ")}` };
  const pj = join(dir, "node_modules", ...src.package.split("/"), "package.json");
  const version = existsSync(pj) ? JSON.parse(readFileSync(pj, "utf8")).version ?? null : null;
  return { ok: true, dir, version };
}

// ── fork reads the conformance checks compare against ────────────────────────

async function ethCall(rpc, to, data, fetchImpl = fetch) {
  const res = await fetchImpl(rpc, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    signal: AbortSignal.timeout(TIME.fetch),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message ?? "eth_call failed");
  return BigInt(j.result).toString();
}

const pad = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

export async function expectedValue(rpc, exp, fetchImpl = fetch) {
  if (!exp) return null;
  if (exp.kind === "erc20_balance") return { ...exp, value: await ethCall(rpc, exp.token, `0x70a08231${pad(exp.owner)}`, fetchImpl) };
  if (exp.kind === "erc20_allowance") return { ...exp, value: await ethCall(rpc, exp.token, `0xdd62ed3e${pad(exp.owner)}${pad(exp.spender)}`, fetchImpl) };
  throw new Error(`unknown expectation ${exp.kind}`);
}

// ── per-source runners → { tools, calls } ────────────────────────────────────

async function runMcp(src, dir, actions) {
  const server = startServer(join(dir, "node_modules", ".bin", src.bin), [], { cwd: dir });
  const calls = {};
  let tools = {};
  let toolCount = null;
  try {
    try {
      await withTimeout(server.initialize(), TIME.start, "initialize");
    } catch (e) {
      const step = e.step === "timeout" ? "timeout" : "initialize";
      for (const a of actions) calls[a.id] = { ok: false, step, error: `${e.message} ${server.stderr.slice(-300)}`.trim() };
      return { tools, calls, toolCount };
    }
    let list;
    try {
      list = await withTimeout(server.listTools(), TIME.start, "tools_list");
    } catch (e) {
      for (const a of actions) calls[a.id] = { ok: false, step: e.step === "timeout" ? "timeout" : "tools_list", error: e.message };
      return { tools, calls, toolCount };
    }
    toolCount = list.length;
    tools = Object.fromEntries(list.map((t) => [t.name, { description: t.description ?? "", inputSchema: t.inputSchema, outputSchema: t.outputSchema ?? null }]));
    for (const a of actions) {
      if (!tools[a.name]) { calls[a.id] = { ok: false, step: "tool_missing", error: `the server no longer lists ${a.name}` }; continue; }
      try {
        calls[a.id] = { ok: true, output: await withTimeout(server.callTool(a.name, a.args), TIME.call, "call") };
      } catch (e) {
        calls[a.id] = { ok: false, step: e.step === "timeout" ? "timeout" : "call", error: e.message };
      }
    }
    return { tools, calls, toolCount };
  } finally {
    server.stop();
  }
}

async function runLibrary(srcId, dir, actions, rpc) {
  const payload = { source: srcId, dir, rpc, calls: actions.map((a) => ({ id: a.id, name: a.name, provider: a.provider, args: a.args, wallet_address: a.wallet_address })) };
  const r = await run(process.execPath, [join(ROOT, "scripts", "harness", "library-check.mjs"), JSON.stringify(payload)], { cwd: dir, env: bareEnv(), timeoutMs: TIME.library });
  const line = r.out.trim().split("\n").filter(Boolean).pop();
  if (r.code !== 0 || !line) {
    const step = r.signal === "SIGKILL" ? "timeout" : "load";
    return { tools: {}, calls: Object.fromEntries(actions.map((a) => [a.id, { ok: false, step, error: (r.err || `exited ${r.code ?? r.signal}`).slice(-600) }])) };
  }
  return JSON.parse(line);
}

async function runSkills(src, actions, fetchImpl = fetch) {
  const { owner, repo, branch } = src.github;
  const calls = {};
  const tools = {};
  let sha = null;
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/commits/${branch}`, { headers: { "user-agent": UA, accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(TIME.fetch) });
    if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
    sha = (await res.json()).sha;
  } catch (e) {
    for (const a of actions) calls[a.id] = { ok: false, step: "fetch", error: String(e.message) };
    return { tools, calls, version: null };
  }
  for (const a of actions) {
    try {
      const res = await fetchImpl(`https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${a.path}`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(TIME.fetch) });
      if (!res.ok) { calls[a.id] = { ok: false, step: "fetch", error: `SKILL.md answered HTTP ${res.status} at ${sha.slice(0, 12)}` }; continue; }
      const text = await res.text();
      calls[a.id] = { ok: true, output: text };
    } catch (e) {
      calls[a.id] = { ok: false, step: "fetch", error: String(e.message) };
    }
  }
  return { tools, calls, version: sha ? sha.slice(0, 12) : null };
}

// ── one action → one result record (pure) ────────────────────────────────────

export function buildRecord(action, src, { version, call, tool, toolCount, expected, custody }) {
  let conformance;
  let lint = null;
  let description = null;
  if (src.kind === "skill") {
    if (call?.ok) {
      conformance = skillConformance(call.output, action.name);
      const fm = parseFrontmatter(call.output);
      description = typeof fm?.description === "string" ? fm.description : null;
      if (description !== null) lint = lintSkill({ description });
    } else conformance = { result: "fail", step: call?.step ?? "fetch", detail: call?.error ?? null };
  } else {
    if (tool) {
      description = tool.description ?? "";
      lint = lintTool({ name: action.name, description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema }, { serverToolCount: toolCount ?? undefined });
    }
    if (!call) conformance = { result: "not_run", step: "no_call", detail: null };
    else if (!call.ok) conformance = { result: "fail", step: call.step ?? "call", detail: call.error ?? null };
    else {
      let why;
      try { why = action.assert(call.output, expected); } catch (e) { why = `the check could not read the output: ${e.message}`; }
      conformance = why ? { result: "fail", step: "assert", detail: String(why).slice(0, 600) } : { result: "pass", step: null, detail: null };
    }
  }
  return {
    id: action.id,
    name: action.name,
    source: { kind: src.kind, package: src.package, version: version ?? null, repo_url: src.repo_url },
    upstream_version: version ?? null,
    checks: { conformance, schema_lint: schemaLintCell(lint), custody },
    description_digest: description === null ? null : sha256(description),
  };
}

// ── main ─────────────────────────────────────────────────────────────────────

function arg(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

export async function main(argv = process.argv.slice(2)) {
  const out = resolve(arg(argv, "--out", "action-results"));
  const rpc = arg(argv, "--rpc", null);
  const work = resolve(arg(argv, "--work", mkdtempSync(join(tmpdir(), "sato-actions-"))));
  const only = arg(argv, "--only", "").split(",").map((s) => s.trim()).filter(Boolean);
  mkdirSync(out, { recursive: true });
  mkdirSync(work, { recursive: true });

  const selected = ACTIONS.filter((a) => !only.length || only.includes(a.id));
  const bySource = new Map();
  for (const a of selected) bySource.set(a.source, [...(bySource.get(a.source) ?? []), a]);

  const custodyCache = new Map();
  const records = [];
  for (const [srcId, actions] of bySource) {
    const src = SOURCES[srcId];
    console.log(`── ${srcId} (${actions.length})`);
    const key = `${src.custody.kind}:${src.custody.target}`;
    if (!custodyCache.has(key)) custodyCache.set(key, await fetchCustody(src.custody.target, src.custody.kind));
    const custody = custodyCache.get(key);

    let result = { tools: {}, calls: {} };
    let version = null;
    const expected = {};
    let blocked = null;
    if (src.runner === "skill") {
      const r = await runSkills(src, actions);
      result = r;
      version = r.version;
    } else {
      const inst = await install(srcId, src, work);
      if (!inst.ok) blocked = { step: inst.step, error: inst.detail };
      else {
        version = inst.version;
        const forkNeeded = actions.some((a) => a.needs_fork);
        if (forkNeeded && !rpc) blocked = { step: "no_fork", error: "no --rpc given; the fork checks need an anvil fork of Base" };
        for (const a of actions) {
          if (blocked || !a.expected) continue;
          try { expected[a.id] = await expectedValue(rpc, a.expected); } catch (e) { expected[a.id] = { error: e.message }; }
        }
        if (!blocked) {
          result = src.runner === "mcp" ? await runMcp(src, inst.dir, actions) : await runLibrary(srcId, inst.dir, actions, rpc);
        }
      }
    }
    for (const a of actions) {
      let call = blocked ? { ok: false, step: blocked.step, error: blocked.error } : result.calls[a.id];
      if (expected[a.id]?.error) call = { ok: false, step: "anvil_read", error: expected[a.id].error };
      const rec = buildRecord(a, src, { version, call, tool: result.tools?.[a.name], toolCount: result.toolCount ?? null, expected: expected[a.id], custody });
      if (blocked?.step === "no_fork" || call?.step === "anvil_read") rec.run_error = call.step; // ours, not upstream's
      records.push(rec);
      const safe = a.id.replace(/[^A-Za-z0-9._-]/g, "_");
      writeFileSync(join(out, `${safe}.json`), JSON.stringify(rec, null, 2) + "\n");
      const c = rec.checks.conformance;
      console.log(`  ${a.id}: ${c.result}${c.step ? ` (${c.step})` : ""} · lint ${rec.checks.schema_lint.result} · custody ${rec.checks.custody.result} · ${rec.upstream_version ?? "?"}`);
    }
  }
  return records;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
}
