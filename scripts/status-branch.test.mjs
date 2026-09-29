// main is code-only behind a required check: no workflow may push to it.
// Bot data (status.json, actions-status.json, badges/) goes to the `status`
// branch, written from a `status-data` checkout of that branch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const dir = ".github/workflows";
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
const read = (f) => readFileSync(`${dir}/${f}`, "utf8");
// Every `git push` command, with its line (comments stripped).
const pushes = (text) => text.split("\n").map((l) => l.replace(/#.*$/, "")).filter((l) => /\bgit\b[^\n]*\bpush\b/.test(l));

test("no workflow step pushes to main", () => {
  for (const f of files) {
    for (const line of pushes(read(f))) {
      assert.doesNotMatch(line, /\b(HEAD:)?(refs\/heads\/)?main\b/, `${f}: ${line.trim()}`);
      assert.doesNotMatch(line, /--force|\s-f\b/, `${f}: forced push: ${line.trim()}`);
      // A bare `git push` / `git push origin` pushes the current branch, which is main on a scheduled run.
      assert.match(line, /git push \S+ \S+/, `${f}: push must name a refspec: ${line.trim()}`);
    }
  }
});

test("both bot jobs write the status branch from a status-data checkout", () => {
  for (const [f, file] of [["nightly.yml", "status.json"], ["actions-status.yml", "actions-status.json"]]) {
    const t = read(f);
    assert.match(t, /uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+ref: status\n\s+path: status-data/, `${f}: pinned checkout of status into status-data`);
    assert.match(t, new RegExp(`--status status-data/${file.replace(".", "\\.")}`), `${f}: reads/writes status-data/${file}`);
    assert.match(t, /working-directory: status-data/, `${f}: commits inside status-data`);
    assert.match(t, /pull --rebase origin status && git push origin HEAD:status/, `${f}: rebase-and-retry push to status`);
    assert.doesNotMatch(t, /--status (status|actions-status)\.json/, `${f}: no step reads main's frozen copy`);
  }
  assert.match(read("nightly.yml"), /--badges status-data\/badges/);
});
