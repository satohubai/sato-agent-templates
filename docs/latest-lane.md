# The latest lane

Every night `nightly.yml` verifies each template × framework on two lanes:

- **pinned**: the exact versions in the template's lockfile.
- **latest**: the same checks after `scripts/resolve-latest.mjs` moves every non-vendored dependency to its newest published version (registry.npmjs.org only, `--ignore-scripts`). The vendored `@satohub/kit` tarball is never touched. The result cell carries `lane: "latest"` and the resolved versions.

**Framework rule.** A dependency moves to `@latest` only as far as the template's framework accepts. Two kinds of declared range hold it back: a peer range on it from any package in the resolved tree (optional peers included; npm enforces them when the package is present), and a dependency range on it from another direct dependency (the framework), so template and framework share one copy. When `@latest` breaks one of those ranges, the lane takes the newest published version that satisfies all of them and logs `framework rule: holding <pkg> at <v> …`. Forcing past them tests npm's resolver or a duplicated package, not the template. Seen 2026-09-28 on `base-guarded-trader/agentkit`: `typescript@7` broke `@solana/kit`'s peer `typescript@^5` (install failed) and `viem@latest` beside `@coinbase/agentkit`'s exact `viem@2.38.3` gave two viem copies whose types do not match.

**`SATO_LANE`.** The verify action exports `SATO_LANE=<pinned|latest>` to every step. Each template's "upstream pins match the lockfile" test skips when `SATO_LANE=latest` (the lane changes versions on purpose) and runs on pinned. Before this, that self-consistency test failed every latest cell whose versions moved, whether or not anything upstream broke.

The matrix is discovered, not listed: every `templates/*/*/sato.template.json` is a cell (`scripts/discover-templates.mjs`), in both `nightly.yml` and `ci.yml` (CI runs the pinned lane).

## What the status job does (`scripts/latest-lane.mjs`)

| Tonight | Action |
|---|---|
| pinned red or error | status is recorded, then the job fails (page) |
| latest green, pinned green, pinned behind | one PR per template/framework on `bump/<template>-<framework>-<date>`, moving the exact pins and the lockfile to the versions that passed tonight's checks; never a second open bump PR for the same pair |
| latest red, pinned green | one issue, deduped by title, with the failing step, the attribution, every changed version and a log excerpt (titles below) |
| latest green | closes any open `upstream break: … breaks <template>/<framework>` or `upstream drift in <template>/<framework>: …` issue |
| latest error (runner problem) | nothing |

### Attribution: one-package bisect

A red latest cell runs `scripts/bisect-latest.mjs` inside the verify action (step `bisect`, 10-minute time box, never changes the cell's result). For each package whose version changed, by name: restore the pinned `package.json` and lockfile, upgrade exactly that one package, and re-run the steps from `install` through the one that failed. The first single upgrade that fails again is the cause.

| Bisect outcome | Issue title |
|---|---|
| one upgrade alone reproduces it (or only one package changed) | `upstream break: <pkg>@<version> breaks <template>/<framework>` |
| every upgrade alone passes | `upstream drift in <template>/<framework>: a combination of newer versions fails <step>` |
| time box reached, or the failing step cannot be re-run alone | `upstream drift in <template>/<framework>: newer versions fail <step> (not attributed)` |

A package is never named because it sorts first. The issue body lists every single-upgrade trial and every changed version.

The decisions are pure functions (`decide()`), unit-tested in `scripts/latest-lane.test.mjs` and `scripts/attribution.test.mjs`. Only the status job has write permissions (`contents`, `pull-requests`, `issues`), through `GITHUB_TOKEN`; no secrets.

Owner settings: "Allow GitHub Actions to create and approve pull requests" must be on (Settings → Actions → General) for bump PRs. PRs opened with `GITHUB_TOKEN` do not trigger `ci.yml` on their own; close and reopen the PR (or push to it) to run CI.

## Drift drill

`workflow_dispatch` takes `inject_drift: <pkg>@<version>`, which forces that version in the latest lane only. After this lands on `main`:

```
gh workflow run nightly.yml -R satohubai/sato-agent-templates -f inject_drift=viem@1.0.0
```

Expected: every latest cell goes red (viem 1.x lacks exports the templates import), the pinned cells stay green, the run stays green, and one issue per template opens, titled `upstream break: viem@1.0.0 breaks <template>/plain-ts`. The next normal night where the latest lane passes closes them.
