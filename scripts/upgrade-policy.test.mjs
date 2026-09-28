import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { allowedTarget, breakingLine, bumpActions, bumpBranch, heldInLatest, heldReason, planBumps, runtimeMajor, validatePolicy } from "./lib/upgrade-policy.mjs";
import { bumpBody } from "./latest-lane.mjs";
import { applyResults } from "./update-status.mjs";
import { selectCells } from "./discover-templates.mjs";

const POLICY = { schema: "sato.upgrade-policy/v1", allow_major: [] };
const R = 22;

test("the repo's upgrade-policy.json is valid and allows no majors by default", () => {
  const p = validatePolicy(JSON.parse(readFileSync(new URL("../upgrade-policy.json", import.meta.url), "utf8")));
  assert.deepEqual(p.allow_major, []);
  assert.throws(() => validatePolicy({ schema: "x", allow_major: [] }));
  assert.throws(() => validatePolicy({ schema: "sato.upgrade-policy/v1", allow_major: "viem" }));
});

test("breaking line: major for >=1, minor for 0.x, patch for 0.0.x", () => {
  assert.equal(breakingLine("5.9.3"), "5");
  assert.equal(breakingLine("0.3.283"), "0.3");
  assert.equal(breakingLine("0.0.7"), "0.0.7");
  assert.equal(runtimeMajor({ runtime: { version: "22" } }), 22);
  assert.equal(runtimeMajor({ runtime: { version: "20.11" } }), 20);
});

test("@types/node follows the runtime major, never higher, even if listed in allow_major", () => {
  const versions = ["22.20.4", "22.21.0", "24.1.0", "26.0.0", "22.22.0-beta.1"];
  assert.equal(allowedTarget({ name: "@types/node", pinned: "22.20.4", versions, policy: POLICY, runtime: R }), "22.21.0");
  assert.equal(allowedTarget({ name: "@types/node", pinned: "22.20.4", versions, policy: { ...POLICY, allow_major: ["@types/node"] }, runtime: R }), "22.21.0");
  assert.match(heldReason({ name: "@types/node", pinned: "22.20.4", candidate: "26.0.0", policy: POLICY, runtime: R }), /runtime major \(Node 22\)/);
});

test("no automatic major: typescript 5 → 7 is held, 5.x patches and minors go through", () => {
  const versions = ["5.9.3", "5.9.4", "6.0.0", "7.0.2"];
  assert.equal(allowedTarget({ name: "typescript", pinned: "5.9.3", versions, policy: POLICY, runtime: R }), "5.9.4");
  assert.match(heldReason({ name: "typescript", pinned: "5.9.3", candidate: "7.0.2", policy: POLICY, runtime: R }), /major upgrade 5 → 7/);
});

test("allow_major opts one package in, and only that one", () => {
  const p = { ...POLICY, allow_major: ["viem"] };
  assert.equal(allowedTarget({ name: "viem", pinned: "2.56.9", versions: ["3.0.0", "2.60.0"], policy: p, runtime: R }), "3.0.0");
  assert.equal(allowedTarget({ name: "typescript", pinned: "5.9.3", versions: ["7.0.2"], policy: p, runtime: R }), null);
});

test("0.x: a minor change counts as a major; 0.0.x: a patch change does", () => {
  assert.equal(allowedTarget({ name: "@openai/agents", pinned: "0.18.0", versions: ["0.18.1", "0.18.4", "0.19.0", "1.0.0"], policy: POLICY, runtime: R }), "0.18.4");
  assert.match(heldReason({ name: "@openai/agents", pinned: "0.18.0", candidate: "0.19.0", policy: POLICY, runtime: R }), /0\.x change 0\.18 → 0\.19/);
  assert.equal(allowedTarget({ name: "x", pinned: "0.0.3", versions: ["0.0.4", "0.0.5"], policy: POLICY, runtime: R }), null);
  assert.equal(allowedTarget({ name: "x", pinned: "0.0.3", versions: ["0.0.4"], policy: { ...POLICY, allow_major: ["x"] }, runtime: R }), "0.0.4");
});

test("prereleases and older versions never count", () => {
  assert.equal(allowedTarget({ name: "viem", pinned: "2.56.9", versions: ["2.57.0-canary.1", "2.50.0", "2.56.9"], policy: POLICY, runtime: R }), null);
});

const PKG = {
  dependencies: { "@satohub/kit": "file:vendor/satohub-kit-0.1.0.tgz", "@openai/agents": "0.18.0", viem: "2.56.9" },
  devDependencies: { "@types/node": "22.20.4", typescript: "5.9.3", tsx: "4.23.15" },
};
const REG = {
  "@satohub/kit": ["0.1.0", "0.2.0", "9.0.0"],
  "@openai/agents": ["0.18.0", "0.18.2", "0.19.0"],
  viem: ["2.56.9", "2.60.1", "3.0.0"],
  "@types/node": ["22.20.4", "22.21.1", "26.0.0"],
  typescript: ["5.9.3", "7.0.2"],
  tsx: ["4.23.15"],
};

test("plan: split by class, vendored untouched, held majors listed with reasons", () => {
  const plan = planBumps({ pkg: PKG, registry: REG, policy: POLICY, runtime: R });
  assert.deepEqual(plan.dependencies.map((v) => `${v.name}@${v.to}`), ["@openai/agents@0.18.2", "viem@2.60.1"]);
  assert.deepEqual(plan.devDependencies.map((v) => `${v.name}@${v.to}`), ["@types/node@22.21.1"]);
  assert.ok(![...plan.dependencies, ...plan.devDependencies].some((v) => v.name === "@satohub/kit"));
  assert.deepEqual(plan.held.map((h) => `${h.pkg}@${h.latest}`), ["@openai/agents@0.19.0", "viem@3.0.0", "@types/node@26.0.0", "typescript@7.0.2"]);
  for (const h of plan.held) assert.ok(h.reason && h.pinned && h.class, JSON.stringify(h));
});

test("bump actions: one PR per template × class; an open PR is updated, never duplicated", () => {
  const plan = planBumps({ pkg: PKG, registry: REG, policy: POLICY, runtime: R });
  const plans = [{ template: "t", framework: "plain-ts", plan }];
  const a = bumpActions({ plans });
  assert.deepEqual(a.map((x) => [x.branch, x.mode, x.class]), [["bump/t-plain-ts-deps", "open", "dependencies"], ["bump/t-plain-ts-dev", "open", "devDependencies"]]);
  const b = bumpActions({ plans, openPrs: [{ number: 41, headRefName: bumpBranch("t", "plain-ts", "devDependencies") }, { number: 9, headRefName: "bump/t-plain-ts2-deps" }] });
  assert.deepEqual(b.map((x) => [x.mode, x.number]), [["open", null], ["update", 41]]);
  const body = bumpBody(b[1]);
  assert.match(body, /class `devDependencies`/);
  assert.match(body, /`@types\/node` \| devDependencies \| 22\.20\.4 \| 22\.21\.1/);
  assert.match(body, /`typescript` \| devDependencies \| 5\.9\.3 \| 7\.0\.2 \| major upgrade 5 → 7/);
  assert.match(body, /`viem` \| dependencies \| 2\.56\.9 \| 3\.0\.0/, "held majors of the other class are listed too");
  assert.doesNotMatch(body, /safe|guarantee/i);
});

test("nothing allowed: no PR, even when the latest lane moved majors", () => {
  const plan = planBumps({ pkg: { devDependencies: { typescript: "5.9.3" } }, registry: { typescript: ["5.9.3", "7.0.2"] }, policy: POLICY, runtime: R });
  assert.deepEqual(bumpActions({ plans: [{ template: "t", framework: "f", plan }] }), []);
  assert.equal(plan.held.length, 1);
});

test("latest cell: held lists what the latest lane tested beyond the policy", () => {
  const held = heldInLatest({ pkg: PKG, resolved: { "@satohub/kit": "0.1.0", "@openai/agents": "0.18.2", viem: "2.60.1", "@types/node": "26.0.0", typescript: "7.0.2", tsx: "4.23.15" }, policy: POLICY, runtime: R });
  assert.deepEqual(held.map((h) => [h.pkg, h.pinned, h.latest]), [["@types/node", "22.20.4", "26.0.0"], ["typescript", "5.9.3", "7.0.2"]]);
  const st = applyResults({ cells: [] }, [
    { template: "t", framework: "f", lane: "latest", result: "green", resolved: { typescript: "7.0.2" }, held },
    { template: "t", framework: "f", lane: "pinned", result: "green", resolved: { typescript: "5.9.3" }, held },
  ], { date: "2026-10-01" });
  const latest = st.cells.find((c) => c.lane === "latest"), pinned = st.cells.find((c) => c.lane === "pinned");
  assert.equal(latest.held.length, 2);
  assert.ok(latest.held.every((h) => h.reason));
  assert.equal("held" in pinned, false, "pinned cells carry no held list");
});

test("CI selects only touched templates; .github/ and scripts/ changes run everything", () => {
  const cells = [{ template: "a", framework: "plain-ts" }, { template: "a", framework: "agentkit" }, { template: "b", framework: "plain-ts" }];
  assert.deepEqual(selectCells(cells, ["templates/a/agentkit/package.json"]), [cells[1]]);
  assert.deepEqual(selectCells(cells, ["templates/a/README.md"]), [cells[0], cells[1]]);
  assert.deepEqual(selectCells(cells, ["README.md", "docs/latest-lane.md", "status.json"]), []);
  assert.deepEqual(selectCells(cells, ["templates/b/plain-ts/src/x.ts", ".github/workflows/ci.yml"]), cells);
  assert.deepEqual(selectCells(cells, ["scripts/lib/upgrade-policy.mjs"]), cells);
  assert.deepEqual(selectCells(cells, ["upgrade-policy.json"]), cells);
});

test("workflows: ci.yml is dispatchable with a ref input and the status job may dispatch it", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ci, /workflow_dispatch:\n\s+inputs:\n\s+ref:/);
  assert.match(ci, /--changed/);
  const nightly = readFileSync(new URL("../.github/workflows/nightly.yml", import.meta.url), "utf8");
  assert.match(nightly, /actions: write/);
  const lane = readFileSync(new URL("./latest-lane.mjs", import.meta.url), "utf8");
  assert.match(lane, /"workflow", "run", "ci\.yml", "--ref", branch/);
});

test("framework rule caps a bump: a direct dependency's exact range holds viem, with the reason", () => {
  const pkg = { dependencies: { "@coinbase/agentkit": "0.10.4", viem: "2.38.3" } };
  const plan = planBumps({
    pkg, policy: POLICY, runtime: R,
    registry: { "@coinbase/agentkit": ["0.10.4"], viem: ["2.38.3", "2.56.9"] },
    constraints: { viem: [{ from: "@coinbase/agentkit", range: "2.38.3", versions: ["2.38.3"] }] },
  });
  assert.deepEqual(plan.dependencies, []);
  assert.deepEqual(plan.held, [{ pkg: "viem", class: "dependencies", pinned: "2.38.3", latest: "2.56.9", reason: "framework rule: @coinbase/agentkit wants 2.38.3" }]);
});
