# Sato agent templates

Onchain-agent templates built on the Sato Kit (`@satohub/kit`). Every template here is installed and checked every night, and the result is committed to [`status.json`](status.json).

- Templates live at `templates/<id>/<framework>/`.
- The default network is a local fork. No template here signs on mainnet.
- No secrets live in this repository. The nightly checks run with none.

## Templates

| Template | Framework | What it does | Last green |
|---|---|---|---|
| [`base-guarded-trader`](templates/base-guarded-trader/plain-ts) | plain TypeScript | Reads Base market data, decides with a small `Model` interface, and runs every intent through the kit: quote, prepare, simulate and a policy pre-flight that names the rule, limit and observed value of every refusal. Signs only on a local fork with a throwaway key or on Base Sepolia with a managed wallet. | ![last green](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsatohubai%2Fsato-agent-templates%2Fmain%2Fbadges%2Fbase-guarded-trader-plain-ts.json) |

## The nightly checks

`.github/workflows/nightly.yml` runs every night at 06:23 UTC for each template × framework on the **pinned** lane (the exact versions in the template's lockfile):

1. `npm ci` from the npm registry only, with install scripts off;
2. `npm run typecheck`;
3. `npm start -- --mode fixture` — recorded fixtures, no network, no key;
4. `npm test`;
5. `npm run fork-check` against an anvil fork of Base at block 51800000: exact reads, a transaction simulation, and the policy pre-flight's answers. Nothing is broadcast;
6. a custody check of the template's dependencies with [`satohubai/preflight-action`](https://github.com/satohubai/preflight-action).

## status.json

One entry per template × framework × lane:

| Field | Meaning |
|---|---|
| `last_run` | the date of the most recent nightly run |
| `last_green` | the most recent date every check passed; `null` if never |
| `result` | `green`, `red` (a check failed) or `error` (the run left no result) |
| `failing_step` | the first check that failed, or `null` |
| `log_excerpt` | the last 40 lines of that check's output |
| `resolved` | the exact package versions the run installed |
| `history` | the last 30 runs as `{ date, result }` |

`badges/<template>-<framework>.json` is the same date in shields.io endpoint format.

A green entry means the template passed tonight's checks on that date. It is not a security review, not a statement that the template is fit for your use, and it says nothing about returns. The status job commits these files to `main` daily; that commit also keeps GitHub from disabling the schedule after 60 days without activity.

## Updating the kit

Until `@satohub/kit` is published to npm, each template vendors a preview tarball in `vendor/`. `scripts/vendor-kit.sh <ref>` rebuilds it from `satohubai/sato-hub-integrations` at that ref.

Licensed MIT.
