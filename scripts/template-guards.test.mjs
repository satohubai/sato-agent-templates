import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { countTests, declaredNodeVersion, nodeMajorMismatch, testCountProblem } from "./template-guards.mjs";

test("countTests reads tap and spec summaries; last one wins", () => {
  assert.equal(countTests("TAP version 13\nok 1 - a\n1..3\n# tests 3\n# pass 3\n"), 3);
  assert.equal(countTests("✔ a\nℹ tests 5\nℹ pass 5\n"), 5);
  assert.equal(countTests("# tests 0\n# pass 0\n"), 0);
  assert.equal(countTests("# tests 2\n...\n# tests 7\n"), 7);
  assert.equal(countTests("npm ERR! nothing\n"), null);
});

test("testCountProblem fails zero and missing, passes any positive count", () => {
  assert.match(testCountProblem(0), /0 tests/);
  assert.match(testCountProblem(null), /no test summary/);
  assert.equal(testCountProblem(1), null);
});

test("nodeMajorMismatch refuses a different major only", () => {
  assert.equal(nodeMajorMismatch("22", "22.11.0"), null);
  assert.equal(nodeMajorMismatch("22.4", "v22.1.0"), null);
  assert.match(nodeMajorMismatch("20", "22.11.0"), /declares Node 20.*runs Node 22/);
  assert.match(nodeMajorMismatch("24", "22.1.0"), /Node 24/);
});

test("declaredNodeVersion reads runtime.version and rejects junk", () => {
  assert.equal(declaredNodeVersion({ runtime: { kind: "node", version: "22" } }), "22");
  assert.throws(() => declaredNodeVersion({ runtime: { kind: "node" } }));
  assert.throws(() => declaredNodeVersion({ runtime: { kind: "node", version: "latest" } }));
  assert.throws(() => declaredNodeVersion({ runtime: { kind: "bun", version: "1" } }));
});

test("every shipped template declares a readable Node version", () => {
  const root = new URL("../templates/", import.meta.url);
  for (const t of readdirSync(root)) for (const f of readdirSync(new URL(`${t}/`, root))) {
    const m = JSON.parse(readFileSync(new URL(`${t}/${f}/sato.template.json`, root), "utf8"));
    assert.ok(declaredNodeVersion(m), `${t}/${f}`);
  }
});

test("verify action takes Node from the template and guards count + major", () => {
  const a = readFileSync(new URL("../.github/actions/verify-template/action.yml", import.meta.url), "utf8");
  assert.match(a, /node-version: \$\{\{ steps\.runtime\.outputs\.node \}\}/);
  assert.doesNotMatch(a, /node-version: "22"/);
  assert.match(a, /template-guards\.mjs" check-node/);
  assert.match(a, /template-guards\.mjs" check-tests "\$LOG_DIR\/test\.log"/);
});
