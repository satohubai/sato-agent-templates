// Provenance guard. Code vendored into this repo names its source as
// "Sato Hub app (private)", never by a GitHub path or a personal address.
// A provenance note once named the private app repo by its GitHub path; this
// test keeps that from coming back without holding any value it looks for.
//
// Two rules over every tracked text file:
//   1. no `<owner>/onchain-agent` path (the private app repo; the public index
//      repo is `satohubai/onchain-agents`, plural, and is fine);
//   2. every email address is on ALLOWED_EMAILS.
// Failures name a file and a line, never the matched text.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const ALLOWED_EMAILS = [
  /^satohub88@gmail\.com$/i,
  /^[^@]+@satohub\.ai$/i,
  /^[^@]+@users\.noreply\.github\.com$/i,
  /^noreply@github\.com$/i,
  /^[^@]+@example\.(com|org|net)$/i,
];
const SKIP = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$|\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|zip|tgz|gz|pdf|mp4|mov)$/i;
const APP_REPO_PATH = /(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]+\/onchain-agent(?![A-Za-z0-9_-])/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

function trackedTextFiles() {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((p) => p && !SKIP.test(p))
    .map((p) => {
      try {
        return { path: p, text: readFileSync(`${root}/${p}`, "utf8") };
      } catch {
        return null; // deleted in the working tree
      }
    })
    .filter(Boolean);
}

export function provenanceFindings(files) {
  const out = [];
  for (const f of files) {
    const lines = f.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (APP_REPO_PATH.test(lines[i])) out.push(`${f.path}:${i + 1} names the private app repo by path`);
      for (const m of lines[i].matchAll(EMAIL)) {
        if (!ALLOWED_EMAILS.some((re) => re.test(m[0]))) out.push(`${f.path}:${i + 1} has an email not on the allowlist`);
      }
    }
  }
  return out;
}

test("the rules catch a repo path and an unlisted email, and pass neutral text", () => {
  // Built at runtime so this file's own text passes the scan below.
  const badPath = ["someone", "onchain-agent"].join("/");
  const badEmail = ["someone", "gmail.com"].join("@");
  assert.equal(provenanceFindings([{ path: "x.md", text: `Source: \`${badPath}\` (private)` }]).length, 1);
  assert.equal(provenanceFindings([{ path: "x.md", text: `by ${badEmail}` }]).length, 1);
  assert.deepEqual(
    provenanceFindings([{ path: "x.md", text: "Source: Sato Hub app (private)\nsatohubai/onchain-agents\nSato Hub <satohub88@gmail.com>\n@satohub/kit@0.1.1" }]),
    [],
  );
});

test("no tracked file names the private app repo or an unlisted email", () => {
  const files = trackedTextFiles();
  assert.ok(files.length > 10);
  const findings = provenanceFindings(files);
  assert.deepEqual(findings, [], `vendored provenance must read "Sato Hub app (private)"; allowlist new public addresses in scripts/provenance.test.mjs`);
});
