import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, versionDiff, issueTitle, bumpBody, issueBody } from "./latest-lane.mjs";
import { discoverCells, matrixFor, expectList } from "./discover-templates.mjs";
import { planLatest, parseInject, npmArgs } from "./resolve-latest.mjs";
import { applyResults } from "./update-status.mjs";

const D = "2026-10-01";
const PIN = { "@satohub/kit": "0.1.0", viem: "2.56.9", typescript: "5.9.3" };
const cell = (lane, result, resolved = PIN, extra = {}) => ({
  template: "base-guarded-trader", framework: "plain-ts", lane, result, last_run: D,
  failing_step: result === "green" ? null : "typecheck", log_excerpt: result === "green" ? null : "error TS2305: no export", resolved, ...extra,
});
const V = { "base-guarded-trader/plain-ts": ["@satohub/kit"] };

test("both green, same versions: nothing", () => {
  assert.deepEqual(decide({ cells: [cell("pinned", "green"), cell("latest", "green")], date: D, vendored: V }), []);
});

test("latest green and pinned behind: one bump PR with the diff", () => {
  const a = decide({ cells: [cell("pinned", "green"), cell("latest", "green", { ...PIN, viem: "2.60.0" })], date: D, vendored: V });
  assert.equal(a.length, 1);
  assert.equal(a[0].type, "bump");
  assert.equal(a[0].branch, `bump/base-guarded-trader-plain-ts-${D}`);
  assert.deepEqual(a[0].versions, [{ name: "viem", from: "2.56.9", to: "2.60.0" }]);
  assert.match(bumpBody(a[0]), /passed tonight's checks/);
});

test("bump dedupe: an open bump PR for the pair (any date) blocks a second", () => {
  const a = decide({
    cells: [cell("pinned", "green"), cell("latest", "green", { ...PIN, viem: "2.60.0" })], date: D, vendored: V,
    openPrs: [{ number: 7, headRefName: "bump/base-guarded-trader-plain-ts-2026-09-28" }],
  });
  assert.deepEqual(a, []);
});

test("an open bump PR for a different pair does not block", () => {
  const a = decide({
    cells: [cell("pinned", "green"), cell("latest", "green", { ...PIN, viem: "2.60.0" })], date: D, vendored: V,
    openPrs: [{ number: 7, headRefName: "bump/base-guarded-trader-plain-ts2-2026-09-28" }, { number: 8, headRefName: "bump/treasury-monitor-plain-ts-2026-09-28" }],
  });
  assert.equal(a[0].type, "bump");
});

test("latest red, pinned green: one issue naming the package and version", () => {
  const a = decide({ cells: [cell("pinned", "green"), cell("latest", "red", { ...PIN, viem: "3.0.0" })], date: D, vendored: V });
  assert.equal(a.length, 1);
  assert.equal(a[0].type, "issue");
  assert.equal(a[0].title, "upstream break: viem@3.0.0 breaks base-guarded-trader/plain-ts");
  assert.equal(a[0].failing_step, "typecheck");
  const body = issueBody(a[0]);
  assert.match(body, /Failing step: `typecheck`/);
  assert.match(body, /TS2305/);
});

test("issue dedupe by title", () => {
  const a = decide({
    cells: [cell("pinned", "green"), cell("latest", "red", { ...PIN, viem: "3.0.0" })], date: D, vendored: V,
    openIssues: [{ number: 3, title: issueTitle("viem", "3.0.0", { template: "base-guarded-trader", framework: "plain-ts" }) }],
  });
  assert.deepEqual(a, []);
});

test("injected drift: the injected package is named even when others moved too", () => {
  const a = decide({
    cells: [cell("pinned", "green"), cell("latest", "red", { ...PIN, typescript: "6.0.0", viem: "1.0.0" })], date: D, vendored: V,
    inject: { name: "viem", version: "1.0.0" },
  });
  assert.equal(a[0].title, "upstream break: viem@1.0.0 breaks base-guarded-trader/plain-ts");
});

test("injected version that failed to install (no resolved change) is still named", () => {
  const a = decide({ cells: [cell("pinned", "green"), cell("latest", "red", PIN, { failing_step: "resolve_latest" })], date: D, vendored: V, inject: { name: "viem", version: "0.0.0-nope" } });
  assert.equal(a[0].title, "upstream break: viem@0.0.0-nope breaks base-guarded-trader/plain-ts");
});

test("latest green again: closes the open break issue for that pair only", () => {
  const a = decide({
    cells: [cell("pinned", "green"), cell("latest", "green")], date: D, vendored: V,
    openIssues: [
      { number: 3, title: "upstream break: viem@3.0.0 breaks base-guarded-trader/plain-ts" },
      { number: 4, title: "upstream break: viem@3.0.0 breaks treasury-monitor/plain-ts" },
      { number: 5, title: "something else" },
    ],
  });
  assert.deepEqual(a.map((x) => [x.type, x.number]), [["close_issue", 3]]);
});

test("pinned red: page, and no issue or bump for that pair", () => {
  const a = decide({ cells: [cell("pinned", "red"), cell("latest", "red", { ...PIN, viem: "3.0.0" })], date: D, vendored: V });
  assert.deepEqual(a.map((x) => x.type), ["page"]);
});

test("pinned error pages too; latest error files nothing", () => {
  const a = decide({ cells: [cell("pinned", "error"), cell("latest", "error")], date: D, vendored: V });
  assert.deepEqual(a.map((x) => x.type), ["page"]);
  assert.deepEqual(decide({ cells: [cell("pinned", "green"), cell("latest", "error", { ...PIN, viem: "3.0.0" })], date: D, vendored: V }), []);
});

test("stale cells (not run on this date) never act", () => {
  const a = decide({ cells: [cell("pinned", "red", PIN, { last_run: "2026-09-01" }), cell("latest", "green", { ...PIN, viem: "9.0.0" }, { last_run: "2026-09-01" })], date: D, vendored: V });
  assert.deepEqual(a, []);
});

test("vendored packages never produce a bump", () => {
  assert.deepEqual(versionDiff(PIN, { ...PIN, "@satohub/kit": "0.2.0" }, ["@satohub/kit"]), []);
});

test("discovery: every templates/*/*/sato.template.json, sorted, and nothing else", () => {
  const root = mkdtempSync(join(tmpdir(), "disc-"));
  for (const [t, f, has] of [["b-tpl", "plain-ts", true], ["a-tpl", "ai-sdk", true], ["a-tpl", "plain-ts", true], ["c-tpl", "plain-ts", false]]) {
    mkdirSync(join(root, "templates", t, f), { recursive: true });
    if (has) writeFileSync(join(root, "templates", t, f, "sato.template.json"), "{}");
  }
  const cells = discoverCells(root);
  assert.deepEqual(cells, [{ template: "a-tpl", framework: "ai-sdk" }, { template: "a-tpl", framework: "plain-ts" }, { template: "b-tpl", framework: "plain-ts" }]);
  const m = matrixFor(cells, ["pinned", "latest"]);
  assert.equal(m.include.length, 6);
  assert.equal(expectList(matrixFor(cells, ["pinned"])), "a-tpl/ai-sdk/pinned,a-tpl/plain-ts/pinned,b-tpl/plain-ts/pinned");
  assert.throws(() => matrixFor(cells, ["nightly"]));
});

test("discovery finds this repo's templates", () => {
  const ids = discoverCells(".").map((c) => `${c.template}/${c.framework}`);
  for (const t of ["base-guarded-trader/plain-ts", "research-report/plain-ts", "treasury-monitor/plain-ts"]) assert.ok(ids.includes(t), t);
});

test("latest plan: every non-vendored dep to @latest, vendored untouched, registry pinned, scripts off", () => {
  const pkg = { name: "x", dependencies: { "@satohub/kit": "file:vendor/k.tgz", viem: "2.56.9" }, devDependencies: { typescript: "5.9.3", tsx: "4.23.15" } };
  const p = planLatest(pkg);
  assert.deepEqual(p, { dependencies: ["viem@latest"], devDependencies: ["tsx@latest", "typescript@latest"], vendored: ["@satohub/kit"] });
  const args = npmArgs(p.devDependencies, true);
  for (const f of ["--save-dev", "--save-exact", "--ignore-scripts", "--registry=https://registry.npmjs.org/"]) assert.ok(args.includes(f), f);
  assert.deepEqual(planLatest(pkg, parseInject("viem@1.0.0")).dependencies, ["viem@1.0.0"]);
  assert.throws(() => planLatest(pkg, parseInject("left-pad@1.0.0")), /not a non-vendored/);
  assert.throws(() => planLatest(pkg, parseInject("@satohub/kit@9.9.9")), /not a non-vendored/);
});

test("inject input is validated (no shell metacharacters)", () => {
  assert.deepEqual(parseInject("@scope/pkg@1.2.3-beta.1"), { name: "@scope/pkg", version: "1.2.3-beta.1" });
  assert.equal(parseInject(""), null);
  for (const bad of ["viem", "viem@", "viem@1;rm -rf /", "viem@$(id)", "../x@1"]) assert.throws(() => parseInject(bad), bad);
});

test("end to end over update-status: a latest-lane red night files the issue, the next green night closes it", () => {
  const prev = { schema: "sato.template-status/v1", cells: [] };
  const night1 = applyResults(prev, [
    { template: "t", framework: "plain-ts", lane: "pinned", result: "green", resolved: { viem: "2.56.9" } },
    { template: "t", framework: "plain-ts", lane: "latest", result: "red", failing_step: "typecheck", log_excerpt: "boom", resolved: { viem: "3.0.0" } },
  ], { date: "2026-10-01" });
  const a1 = decide({ cells: night1.cells, date: "2026-10-01" });
  assert.deepEqual(a1.map((a) => a.title), ["upstream break: viem@3.0.0 breaks t/plain-ts"]);
  const night2 = applyResults(night1, [
    { template: "t", framework: "plain-ts", lane: "pinned", result: "green", resolved: { viem: "2.56.9" } },
    { template: "t", framework: "plain-ts", lane: "latest", result: "green", resolved: { viem: "3.0.1" } },
  ], { date: "2026-10-02" });
  const a2 = decide({ cells: night2.cells, date: "2026-10-02", openIssues: [{ number: 9, title: a1[0].title }] });
  assert.deepEqual(a2.map((a) => a.type), ["close_issue", "bump"]);
  assert.deepEqual(a2[1].versions, [{ name: "viem", from: "2.56.9", to: "3.0.1" }]);
});

test("bumpUpstreamText moves only the bumped pins inside template.upstream, byte for byte elsewhere", async () => {
  const { bumpUpstreamText } = await import("./latest-lane.mjs");
  const text = '{\n  "id": "x",\n  "runtime": { "typescript": "5.9.3" },\n  "template": {\n    "upstream": { "viem": "2.56.9", "typescript": "5.9.3" }\n  }\n}\n';
  const out = bumpUpstreamText(text, [{ name: "typescript", to: "7.0.2" }, { name: "not-there", to: "1.0.0" }]);
  assert.equal(JSON.parse(out).template.upstream.typescript, "7.0.2");
  assert.equal(JSON.parse(out).template.upstream.viem, "2.56.9");
  assert.equal(JSON.parse(out).runtime.typescript, "5.9.3", "a same-named key outside upstream is untouched");
  assert.equal(out.replace('"7.0.2"', '"5.9.3"'), text);
  for (const f of ["base-guarded-trader/plain-ts", "base-guarded-trader/agentkit", "persona-agent/claude-agent-sdk", "treasury-monitor/plain-ts"]) {
    const { readFileSync } = await import("node:fs");
    const t = readFileSync(`templates/${f}/sato.template.json`, "utf8");
    const pins = JSON.parse(t).template.upstream;
    const [name] = Object.keys(pins);
    const moved = JSON.parse(bumpUpstreamText(t, [{ name, to: "99.0.0" }])).template.upstream;
    assert.deepEqual(moved, { ...pins, [name]: "99.0.0" }, f);
  }
});

test("a failed pull request names the repo setting", async () => {
  const { PR_PERMISSION_HINT } = await import("./latest-lane.mjs");
  assert.match(PR_PERMISSION_HINT, /Allow GitHub Actions to create and approve pull requests/);
});
