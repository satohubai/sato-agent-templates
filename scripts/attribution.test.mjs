import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { decide, breakTitle, issueBody } from "./latest-lane.mjs";
import { attribute, candidates, stepsUpTo, failingStepFrom } from "./bisect-latest.mjs";
import { peerRanges, newestAllowed } from "./resolve-latest.mjs";
import { applyResults } from "./update-status.mjs";

const D = "2026-10-01";
const PAIR = { template: "base-guarded-trader", framework: "plain-ts" };
const PIN = { "@types/node": "22.20.4", typescript: "5.9.3", viem: "2.56.9" };
const LATEST = { "@types/node": "26.6.3", typescript: "7.0.2", viem: "2.56.9" };
const cells = (attribution, failing_step = "test") => [
  { ...PAIR, lane: "pinned", result: "green", last_run: D, resolved: PIN },
  { ...PAIR, lane: "latest", result: "red", last_run: D, failing_step, log_excerpt: "not ok", resolved: LATEST, attribution },
];
const changes = [{ name: "@types/node", from: "22.20.4", to: "26.6.3" }, { name: "typescript", from: "5.9.3", to: "7.0.2" }];

test("bisect outcome single: the reproducing package is named, not the alphabetically-first change", () => {
  const trials = [
    { name: "@types/node", from: "22.20.4", to: "26.6.3", reproduced: false, step: null },
    { name: "typescript", from: "5.9.3", to: "7.0.2", reproduced: true, step: "typecheck" },
  ];
  const at = attribute({ failingStep: "typecheck", changes, trials });
  assert.equal(at.kind, "single");
  assert.equal(at.name, "typescript");
  const a = decide({ cells: cells(at, "typecheck"), date: D });
  assert.equal(a.length, 1);
  assert.equal(a[0].title, "upstream break: typescript@7.0.2 breaks base-guarded-trader/plain-ts");
  const body = issueBody(a[0]);
  assert.match(body, /one-package bisect/);
  assert.match(body, /`typescript` from 5\.9\.3 to 7\.0\.2 alone fails `typecheck`/);
  assert.match(body, /`@types\/node` 22\.20\.4 → 26\.6\.3 alone: passes/);
});

test("bisect outcome combination: no package named; the title says a combination fails the step and the body lists every change", () => {
  const trials = changes.map((c) => ({ ...c, reproduced: false, step: null }));
  const at = attribute({ failingStep: "test", changes, trials });
  assert.equal(at.kind, "combination");
  const a = decide({ cells: cells(at), date: D });
  assert.equal(a[0].title, "upstream drift in base-guarded-trader/plain-ts: a combination of newer versions fails test");
  const body = issueBody(a[0]);
  assert.match(body, /no single upgrade reproduces the failure/);
  for (const c of changes) assert.ok(body.includes(`| \`${c.name}\` | ${c.from} | ${c.to} |`), c.name);
});

test("bisect cut short: inconclusive, and the title names no package", () => {
  const at = attribute({ failingStep: "test", changes, trials: [{ ...changes[0], reproduced: false, step: null }], reason: "time box reached" });
  assert.equal(at.kind, "inconclusive");
  const a = decide({ cells: cells(at), date: D });
  assert.equal(a[0].title, "upstream drift in base-guarded-trader/plain-ts: newer versions fail test (not attributed)");
  assert.match(issueBody(a[0]), /not established \(time box reached\)/);
});

test("no bisect record and several changes: never the alphabetically-first package", () => {
  const t = breakTitle({ pair: PAIR, diff: changes, attribution: null, inject: null, failingStep: "test" });
  assert.ok(!t.includes("@types/node"), t);
  assert.match(t, /not attributed/);
});

test("green latest closes drift issues as well as break issues for that pair only", () => {
  const a = decide({
    cells: [{ ...PAIR, lane: "pinned", result: "green", last_run: D, resolved: PIN }, { ...PAIR, lane: "latest", result: "green", last_run: D, resolved: PIN }],
    date: D,
    openIssues: [
      { number: 1, title: "upstream drift in base-guarded-trader/plain-ts: a combination of newer versions fails test" },
      { number: 2, title: "upstream drift in base-guarded-trader/plain-ts2: a combination of newer versions fails test" },
      { number: 3, title: "upstream break: typescript@7.0.2 breaks base-guarded-trader/plain-ts" },
    ],
  });
  assert.deepEqual(a.map((x) => x.number), [1, 3]);
});

test("attribution survives update-status and is dropped on green", () => {
  const at = attribute({ failingStep: "test", changes, trials: changes.map((c) => ({ ...c, reproduced: false })) });
  const s = applyResults({ cells: [] }, [
    { ...PAIR, lane: "latest", result: "red", failing_step: "test", resolved: LATEST, attribution: at },
    { template: "t", framework: "f", lane: "latest", result: "green", resolved: LATEST, attribution: at },
  ], { date: D });
  assert.equal(s.cells.find((c) => c.template === PAIR.template).attribution.kind, "combination");
  assert.equal(s.cells.find((c) => c.template === "t").attribution, null);
});

test("bisect candidates: only changed, non-vendored direct deps, by name; steps re-run up to the failing one", () => {
  const pinned = { dependencies: { "@satohub/kit": "file:vendor/k.tgz", viem: "2.56.9" }, devDependencies: { typescript: "5.9.3", "@types/node": "22.20.4" } };
  const latest = { dependencies: { "@satohub/kit": "file:vendor/k.tgz", viem: "2.56.9" }, devDependencies: { typescript: "7.0.2", "@types/node": "26.6.3" } };
  assert.deepEqual(candidates(pinned, latest).map((c) => [c.name, c.to, c.dev]), [["@types/node", "26.6.3", true], ["typescript", "7.0.2", true]]);
  assert.deepEqual(stepsUpTo("test", false), ["install", "typecheck", "fixture_run", "test"]);
  assert.deepEqual(stepsUpTo("fork_check", true), ["install", "typecheck", "fixture_run", "test", "fork_check"]);
  assert.equal(stepsUpTo("resolve_latest"), null);
  assert.equal(failingStepFrom({ STEPS_JSON: JSON.stringify({ install: { outcome: "success" }, test: { outcome: "failure" } }), STEP_ORDER: "install,typecheck,test" }), "test");
});

test("framework rule: a direct dep is held at the newest version every declared peer range accepts", () => {
  const lock = { packages: { "": { devDependencies: { typescript: "7.0.2" } }, "node_modules/@solana/kit": { peerDependencies: { typescript: "^5.0.0" } }, "node_modules/viem": { peerDependencies: { typescript: ">=5.0.4" } } } };
  assert.deepEqual(peerRanges(lock, "typescript"), [{ from: "@solana/kit", range: "^5.0.0" }, { from: "viem", range: ">=5.0.4" }]);
  // A framework's own exact dependency on a direct dep holds it (one shared copy);
  // a nested package's plain dependency does not.
  const ak = { packages: { "": {}, "node_modules/@coinbase/agentkit": { dependencies: { viem: "2.38.3" } }, "node_modules/x/node_modules/y": { dependencies: { viem: "^1" } } } };
  assert.deepEqual(peerRanges(ak, "viem", ["@coinbase/agentkit", "viem"]), [{ from: "@coinbase/agentkit", range: "2.38.3" }]);
  assert.deepEqual(peerRanges(ak, "viem", ["viem"]), []);
  assert.deepEqual(peerRanges({ packages: { "node_modules/sushi": { peerDependencies: { viem: "*" } } } }, "viem"), []);
  const ordered = ["5.0.4", "5.8.3", "5.9.3", "6.0.3", "7.0.2"];
  assert.equal(newestAllowed(ordered, [["5.0.4", "5.8.3", "5.9.3"], ordered]), "5.9.3");
  assert.equal(newestAllowed(ordered, [["4.9.5"]]), null);
});

const templateTests = readdirSync("templates").flatMap((t) => readdirSync(join("templates", t)).map((f) => join("templates", t, f, "test", "template.test.ts"))).filter(existsSync);

test("SATO_LANE: every template's pin-consistency test skips on latest, with a reason, and runs on pinned", () => {
  assert.ok(templateTests.length >= 7);
  for (const f of templateTests) {
    const src = readFileSync(f, "utf8");
    assert.match(src, /process\.env\.SATO_LANE === "latest" \? "SATO_LANE=latest: [^"]+" : false/, f);
    assert.match(src, /test\("sato\.template\.json upstream pins match the lockfile", \{ skip: PIN_CHECK_SKIP \}/, f);
  }
  const action = readFileSync(".github/actions/verify-template/action.yml", "utf8");
  assert.match(action, /echo "SATO_LANE=\$\{\{ inputs\.lane \}\}" >> "\$GITHUB_ENV"/);
});

test("SATO_LANE: the skip really fires under node --test (lockfile pins deliberately wrong)", () => {
  const dir = "templates/base-guarded-trader/plain-ts";
  const src = readFileSync(join(dir, "test/template.test.ts"), "utf8");
  const guard = src.slice(src.indexOf("const PIN_CHECK_SKIP"), src.indexOf("\n", src.indexOf("const PIN_CHECK_SKIP")));
  const probe = `import { test } from "node:test";\nimport assert from "node:assert/strict";\n${guard}\ntest("pins", { skip: PIN_CHECK_SKIP }, () => { assert.equal("7.0.2", "5.9.3"); });\n`;
  const file = join(mkdtempSync(join(tmpdir(), "lane-")), "probe.test.mjs");
  writeFileSync(file, probe);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // run as a top-level test process, not a child of this one
  const run = (lane) => spawnSync(process.execPath, ["--test", "--test-reporter=tap", file], { encoding: "utf8", env: { ...env, SATO_LANE: lane } });
  const latest = run("latest");
  assert.equal(latest.status, 0, latest.stdout + latest.stderr);
  assert.match(latest.stdout, /# skip(ped)? 1/);
  assert.notEqual(run("pinned").status, 0);
});
