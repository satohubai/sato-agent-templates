# The latest lane

Every night `nightly.yml` verifies each template × framework on two lanes:

- **pinned**: the exact versions in the template's lockfile.
- **latest**: the same checks after `scripts/resolve-latest.mjs` moves every non-vendored dependency to its newest published version (registry.npmjs.org only, `--ignore-scripts`). The vendored `@satohub/kit` tarball is never touched. The result cell carries `lane: "latest"` and the resolved versions.

**Framework rule.** A dependency moves to `@latest` only as far as the template's framework accepts. Two kinds of declared range hold it back: a peer range on it from any package in the resolved tree (optional peers included; npm enforces them when the package is present), and a dependency range on it from another direct dependency (the framework), so template and framework share one copy. When `@latest` breaks one of those ranges, the lane takes the newest published version that satisfies all of them and logs `framework rule: holding <pkg> at <v> …`. Forcing past them tests npm's resolver or a duplicated package, not the template. Seen 2026-09-28 on `base-guarded-trader/agentkit`: `typescript@7` broke `@solana/kit`'s peer `typescript@^5` (install failed) and `viem@latest` beside `@coinbase/agentkit`'s exact `viem@2.38.3` gave two viem copies whose types do not match.

**`SATO_LANE`.** The verify action exports `SATO_LANE=<pinned|latest>` to every step. Each template's "upstream pins match the lockfile" test skips when `SATO_LANE=latest` (the lane changes versions on purpose) and runs on pinned. Before this, that self-consistency test failed every latest cell whose versions moved, whether or not anything upstream broke.

## The update policy (`upgrade-policy.json`)

The latest lane is the early warning: it still tests the newest published version of everything. What a bump PR may carry is decided separately, by `upgrade-policy.json` (schema `sato.upgrade-policy/v1`, pure rules in `scripts/lib/upgrade-policy.mjs`):

| Rule | Meaning |
|---|---|
| (a) `types_node_follows_runtime` | `@types/node` stays on the template's runtime major (`runtime.version` in `sato.template.json`, Node 22 today). Never a higher major, even if listed in `allow_major`. |
| (b) `allow_major` | No automatic major upgrade of any package unless it is named here. Empty by default: a major is a human decision. |
| (c) `zero_minor_is_major` | For `0.x` packages a change of the minor counts as a major (`0.18 → 0.19`), and for `0.0.x` a change of the patch does. |
| (d) `split_bump_by_class` | One PR for `dependencies` (runtime code, branch `bump/<t>-<f>-deps`) and one for `devDependencies` (tooling, `bump/<t>-<f>-dev`), per template × framework. |
| (e) `never_bump_vendored` | `file:` dependencies (the `@satohub/kit` tarball) are never bumped by the lane. |

The framework rule above applies to bumps too: a version outside a peer range, or outside another direct dependency's range, is not proposed.

Each latest cell in `status.json` carries `held: [{pkg, pinned, latest, reason}]`: every version the latest lane tested that the policy would not put in a bump PR (additive; pinned cells have no `held`).

Why: on 2026-09-28 the nightly opened bump PRs moving `@types/node` 22 → 26 on Node 22 templates, `typescript` 5.9.3 → 7.0.2 (which `@solana/kit`'s `typescript ^5` rejects), and a `0.x` runtime SDK in the same PR as tooling, and those PRs had no CI. All were closed.

The matrix is discovered, not listed: every `templates/*/*/sato.template.json` is a cell (`scripts/discover-templates.mjs`), in both `nightly.yml` and `ci.yml` (CI runs the pinned lane).

## What the status job does (`scripts/latest-lane.mjs`)

| Tonight | Action |
|---|---|
| pinned red or error | status is recorded, then the job fails (page) |
| any upgrade the policy allows (independent of the latest lane's set) | one PR per template × framework × class on `bump/<template>-<framework>-deps` or `-dev`, moving the exact pins, the lockfile and the `sato.template.json` upstream pins to the highest version the policy allows (`npm view <pkg> versions`, registry.npmjs.org only). The body lists every change with its class and every held version with its reason. An open PR for the same branch is updated in place (force-push + new body), never duplicated; unchanged contents are not re-pushed. After each push the job runs `gh workflow run ci.yml --ref <branch>`, so the checks run on exactly the bump commit and show on the PR. |
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

The decisions are pure functions (`decide()`, and `planBumps()` / `bumpActions()` / `heldInLatest()` for the policy), unit-tested in `scripts/latest-lane.test.mjs`, `scripts/attribution.test.mjs` and `scripts/upgrade-policy.test.mjs`.

Only the status job has write permissions (`contents`, `pull-requests`, `issues`, and `actions` to dispatch `ci.yml`), through `GITHUB_TOKEN`; no secrets.

Owner settings: "Allow GitHub Actions to create and approve pull requests" must be on (Settings → Actions → General) for bump PRs. A PR opened or pushed with `GITHUB_TOKEN` triggers no `pull_request` run; `workflow_dispatch` is the exception GitHub allows, which is why the status job dispatches `ci.yml` itself. Do not merge a bump PR whose `ci` run is missing or red.

## CI scope

`ci.yml` verifies only the templates a change touches (`scripts/discover-templates.mjs --changed`): a file under `templates/<t>/<f>/` selects that cell, a file directly under `templates/<t>/` selects every framework of `<t>`, and a change under `.github/` or `scripts/`, or to `upgrade-policy.json` or the root package files, verifies every template. The `scripts` job (`npm test`) always runs, including `scripts/templates-consistency.test.mjs`: every template's `@types/node` major equals its runtime major, every `package.json` pin is exact, and `sato.template.json` upstream pins equal `package.json`.

## Drift drill

`workflow_dispatch` takes `inject_drift: <pkg>@<version>`, which forces that version in the latest lane only. After this lands on `main`:

```
gh workflow run nightly.yml -R satohubai/sato-agent-templates -f inject_drift=viem@1.0.0
```

Expected: every latest cell goes red (viem 1.x lacks exports the templates import), the pinned cells stay green, the run stays green, and one issue per template opens, titled `upstream break: viem@1.0.0 breaks <template>/plain-ts`. The next normal night where the latest lane passes closes them.
