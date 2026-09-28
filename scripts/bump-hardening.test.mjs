import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyBump, bumpBody, dispatchCi, lockfileChanges, lockfileText, needsCiDispatch } from "./latest-lane.mjs";
import { ciResult } from "./ci-result.mjs";

test("ciResult: pass on success or skipped verify, fail otherwise", () => {
  assert.equal(ciResult("success", "success").ok, true);
  assert.equal(ciResult("success", "skipped").ok, true);
  for (const v of ["failure", "cancelled", ""]) assert.equal(ciResult("success", v).ok, false);
  for (const d of ["failure", "cancelled", "skipped"]) assert.equal(ciResult(d, "skipped").ok, false);
});

test("ci.yml has a ci-result job over discover + verify that always runs", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const job = ci.slice(ci.indexOf("\n  ci-result:"));
  assert.match(job, /needs: \[discover, verify\]/);
  assert.match(job, /if: always\(\)/);
  assert.match(job, /node scripts\/ci-result\.mjs "\$DISCOVER" "\$VERIFY"/);
});

const lock = (pkgs) => ({ lockfileVersion: 3, packages: { "": { name: "x" }, ...Object.fromEntries(Object.entries(pkgs).map(([p, v]) => [p, { version: v }])) } });

test("lockfileChanges lists direct, transitive, nested, added and removed", () => {
  const a = lock({ "node_modules/viem": "2.1.0", "node_modules/abitype": "1.0.0", "node_modules/ox": "0.1.0", "node_modules/viem/node_modules/ws": "8.0.0", "node_modules/same": "1.0.0" });
  const b = lock({ "node_modules/viem": "2.2.0", "node_modules/abitype": "1.1.0", "node_modules/viem/node_modules/ws": "8.1.0", "node_modules/@noble/hashes": "1.4.0", "node_modules/same": "1.0.0" });
  assert.deepEqual(lockfileChanges(a, b), [
    { name: "@noble/hashes", path: "node_modules/@noble/hashes", from: null, to: "1.4.0" },
    { name: "abitype", path: "node_modules/abitype", from: "1.0.0", to: "1.1.0" },
    { name: "ox", path: "node_modules/ox", from: "0.1.0", to: null },
    { name: "viem", path: "node_modules/viem", from: "2.1.0", to: "2.2.0" },
    { name: "ws", path: "node_modules/viem/node_modules/ws", from: "8.0.0", to: "8.1.0" },
  ]);
  assert.deepEqual(lockfileChanges(a, a), []);
});

test("bump body carries a Lockfile changes section naming every moved package", () => {
  const base = { template: "t", framework: "f", class: "dependencies", versions: [{ name: "viem", from: "2.1.0", to: "2.2.0" }] };
  const body = bumpBody({ ...base, lockChanges: [{ name: "abitype", path: "node_modules/abitype", from: "1.0.0", to: "1.1.0" }] });
  assert.match(body, /Lockfile changes/);
  assert.match(body, /\| `abitype` \| `node_modules\/abitype` \| 1\.0\.0 \| 1\.1\.0 \|/);
  assert.match(bumpBody({ ...base, lockChanges: [] }), /Lockfile changes: none/);
  assert.equal(lockfileText(null), "Lockfile changes: not computed.\n");
});

test("needsCiDispatch: only a success or running run on the head SHA suffices", () => {
  assert.equal(needsCiDispatch([], "abc"), true);
  assert.equal(needsCiDispatch([{ headSha: "old", status: "completed", conclusion: "success" }], "abc"), true);
  assert.equal(needsCiDispatch([{ headSha: "abc", status: "completed", conclusion: "failure" }], "abc"), true);
  assert.equal(needsCiDispatch([{ headSha: "abc", status: "completed", conclusion: "success" }], "abc"), false);
  assert.equal(needsCiDispatch([{ headSha: "abc", status: "in_progress", conclusion: "" }], "abc"), false);
});

const recorder = (fail = () => false, out = () => "") => {
  const calls = [];
  const sh = (cmd, args) => { calls.push([cmd, ...args].join(" ")); if (fail(cmd, args)) throw new Error("HTTP 403: nope"); return out(cmd, args); };
  return { calls, sh };
};

test("dispatchCi: failed dispatch closes the PR with a comment and deletes the branch", () => {
  const { calls, sh } = recorder((c, a) => a[0] === "workflow");
  assert.throws(() => dispatchCi("bump/t-f-deps", sh), /PR closed and branch deleted/);
  assert.equal(calls[1].startsWith("gh pr close bump/t-f-deps --delete-branch --comment"), true);
  assert.match(calls[1], /no checks ran/);
  const ok = recorder();
  assert.equal(dispatchCi("bump/t-f-deps", ok.sh), "dispatched");
  assert.equal(ok.calls.length, 1);
});

test("dispatchCi: if closing fails too, the branch is still deleted", () => {
  const { calls, sh } = recorder((c, a) => a[0] === "workflow" || a[0] === "pr");
  assert.throws(() => dispatchCi("bump/x", sh));
  assert.equal(calls.at(-1), "git push origin --delete bump/x");
});

const files = { "templates/t/f/package-lock.json": JSON.stringify(lock({ "node_modules/viem": "2.1.0" })), "templates/t/f/sato.template.json": "{}" };
const io = { readFile: (f) => { if (!(f in files)) throw new Error("ENOENT"); return files[f]; }, writeFile: () => {} };
const upd = { mode: "update", number: 7, branch: "bump/t-f-deps", template: "t", framework: "f", class: "dependencies", versions: [{ name: "viem", from: "2.1.0", to: "2.2.0" }] };

test("update path, unchanged contents, no successful run on head: dispatch again", () => {
  const { calls, sh } = recorder(() => false, (c, a) => {
    if (a[0] === "rev-parse") return a[1] === "origin/bump/t-f-deps" ? "HEADSHA\n" : "TREE\n";
    if (a[0] === "run") return JSON.stringify([{ headSha: "HEADSHA", status: "completed", conclusion: "failure" }]);
    return "";
  });
  applyBump(upd, { sh, ...io });
  assert.ok(calls.some((c) => c.startsWith("gh run list --workflow ci.yml --branch bump/t-f-deps")));
  assert.ok(calls.includes("gh workflow run ci.yml --ref bump/t-f-deps -f ref=bump/t-f-deps"));
  assert.ok(!calls.some((c) => c.startsWith("git push")));
});

test("update path, unchanged contents, head already green: nothing dispatched", () => {
  const { calls, sh } = recorder(() => false, (c, a) => {
    if (a[0] === "rev-parse") return a[1] === "origin/bump/t-f-deps" ? "HEADSHA\n" : "TREE\n";
    if (a[0] === "run") return JSON.stringify([{ headSha: "HEADSHA", status: "completed", conclusion: "success" }]);
    return "";
  });
  applyBump(upd, { sh, ...io });
  assert.ok(!calls.some((c) => c.startsWith("gh workflow run")));
});

test("create path: dispatch failure after push closes the PR", () => {
  const { calls, sh } = recorder((c, a) => c === "gh" && a[0] === "workflow");
  assert.throws(() => applyBump({ ...upd, mode: "create", number: undefined }, { sh, ...io }), /PR closed/);
  assert.ok(calls.some((c) => c.startsWith("gh pr create")));
  assert.ok(calls.some((c) => c.startsWith("gh pr close bump/t-f-deps --delete-branch")));
  assert.equal(calls.at(-1), "git checkout --detach origin/main");
});

test("update path, changed contents: a failed body edit still dispatches CI", () => {
  const { calls, sh } = recorder((c, a) => c === "gh" && a[0] === "pr" && a[1] === "edit", (c, a) => {
    if (a[0] === "rev-parse") return a[1] === "HEAD^{tree}" ? "NEWTREE\n" : "OLDTREE\n";
    return "";
  });
  applyBump(upd, { sh, ...io });
  assert.ok(calls.some((c) => c.startsWith("git push --force origin HEAD:refs/heads/bump/t-f-deps")));
  assert.ok(calls.some((c) => c.startsWith("gh pr edit 7")));
  assert.ok(calls.includes("gh workflow run ci.yml --ref bump/t-f-deps -f ref=bump/t-f-deps"));
  assert.equal(calls.at(-1), "git checkout --detach origin/main");
});
