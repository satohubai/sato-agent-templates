# The latest lane

Every night `nightly.yml` verifies each template × framework on two lanes:

- **pinned**: the exact versions in the template's lockfile.
- **latest**: the same checks after `scripts/resolve-latest.mjs` moves every non-vendored dependency to its newest published version (registry.npmjs.org only, `--ignore-scripts`). The vendored `@satohub/kit` tarball is never touched. The result cell carries `lane: "latest"` and the resolved versions.

The matrix is discovered, not listed: every `templates/*/*/sato.template.json` is a cell (`scripts/discover-templates.mjs`), in both `nightly.yml` and `ci.yml` (CI runs the pinned lane).

## What the status job does (`scripts/latest-lane.mjs`)

| Tonight | Action |
|---|---|
| pinned red or error | status is recorded, then the job fails (page) |
| latest green, pinned green, pinned behind | one PR per template/framework on `bump/<template>-<framework>-<date>`, moving the exact pins and the lockfile to the versions that passed tonight's checks; never a second open bump PR for the same pair |
| latest red, pinned green | one issue `upstream break: <pkg>@<version> breaks <template>/<framework>` with the failing step and a log excerpt; deduped by title |
| latest green | closes any open `upstream break: … breaks <template>/<framework>` issue |
| latest error (runner problem) | nothing |

The decisions are pure functions (`decide()`), unit-tested in `scripts/latest-lane.test.mjs`. Only the status job has write permissions (`contents`, `pull-requests`, `issues`), through `GITHUB_TOKEN`; no secrets.

Owner settings: "Allow GitHub Actions to create and approve pull requests" must be on (Settings → Actions → General) for bump PRs. PRs opened with `GITHUB_TOKEN` do not trigger `ci.yml` on their own; close and reopen the PR (or push to it) to run CI.

## Drift drill

`workflow_dispatch` takes `inject_drift: <pkg>@<version>`, which forces that version in the latest lane only. After this lands on `main`:

```
gh workflow run nightly.yml -R satohubai/sato-agent-templates -f inject_drift=viem@1.0.0
```

Expected: every latest cell goes red (viem 1.x lacks exports the templates import), the pinned cells stay green, the run stays green, and one issue per template opens, titled `upstream break: viem@1.0.0 breaks <template>/plain-ts`. The next normal night where the latest lane passes closes them.
