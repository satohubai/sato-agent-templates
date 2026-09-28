# Sato agent templates

Onchain-agent templates built on the Sato Kit (`@satohub/kit`). Every template here is installed and checked every night, and the result is committed to [`status.json`](status.json).

- Templates live at `templates/<id>/<framework>/`.
- The default network is a local fork. No template here signs on mainnet.
- No secrets live in this repository. The nightly checks run with none.

## Templates

| Template | Framework | What it does | Last green |
|---|---|---|---|
| [`base-guarded-trader`](templates/base-guarded-trader/plain-ts) | plain TypeScript | Reads Base market data, decides with a small `Model` interface, and runs every intent through the kit: quote, prepare, simulate and a policy pre-flight that names the rule, limit and observed value of every refusal. Signs only on a local fork with a throwaway key or on Base Sepolia with a managed wallet. | ![last green](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsatohubai%2Fsato-agent-templates%2Fmain%2Fbadges%2Fbase-guarded-trader-plain-ts.json) |
| [`base-guarded-trader`](templates/base-guarded-trader/agentkit) | Coinbase AgentKit | The same agent as the plain TypeScript version, with the kit reached through one AgentKit action provider (`@satohub/kit/agentkit`). A local fork uses a throwaway key; Base Sepolia uses a CDP smart wallet. | ![last green](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsatohubai%2Fsato-agent-templates%2Fmain%2Fbadges%2Fbase-guarded-trader-agentkit.json) |
| [`base-guarded-trader`](templates/base-guarded-trader/claude-agent-sdk) | Claude Agent SDK | The same agent, with the kit's tools handed to the Claude Agent SDK as an in-process MCP server (`@satohub/kit/claude-agent-sdk`). A `PreToolUse` hook asks a person before `swap_prepare` and `execute`. The SDK itself is under Anthropic's own terms, not MIT. | ![last green](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsatohubai%2Fsato-agent-templates%2Fmain%2Fbadges%2Fbase-guarded-trader-claude-agent-sdk.json) |
| [`base-guarded-trader`](templates/base-guarded-trader/openai-agents) | OpenAI Agents SDK | The same agent, with the kit's tools as function tools (`@satohub/kit/openai-agents`). Tools that prepare or execute carry `needsApproval`, so the runner stops for a person. | ![last green](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsatohubai%2Fsato-agent-templates%2Fmain%2Fbadges%2Fbase-guarded-trader-openai-agents.json) |
| [`persona-agent`](templates/persona-agent/claude-agent-sdk) | Claude Agent SDK | A character with a memory that answers on Telegram and Discord, with a wallet through the kit. It covers what builders use ElizaOS for, with no ElizaOS dependency. Connectors stay off until their bot tokens are set; wallet writes need a person's approval. | ![last green](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsatohubai%2Fsato-agent-templates%2Fmain%2Fbadges%2Fpersona-agent-claude-agent-sdk.json) |
| [`treasury-monitor`](templates/treasury-monitor/plain-ts) | plain TypeScript | Reads the native and ERC-20 balances of a public address list on Base through the kit's `chain.read`, reports them in exact base units, and fires a threshold alert once per crossing. Holds no key and moves no funds. | ![last green](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsatohubai%2Fsato-agent-templates%2Fmain%2Fbadges%2Ftreasury-monitor-plain-ts.json) |
| [`research-report`](templates/research-report/plain-ts) | plain TypeScript | Answers a question from a closed corpus of supplied sources plus onchain reads made through the kit's `chain.read`. A model proposes findings; a deterministic gate refuses any that cite an unsupplied source or carry a number no cited source contains. Holds no key and moves no funds. | ![last green](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsatohubai%2Fsato-agent-templates%2Fmain%2Fbadges%2Fresearch-report-plain-ts.json) |

## The nightly checks

`.github/workflows/nightly.yml` runs every night at 06:23 UTC. It finds every `templates/*/*/sato.template.json` on its own, so a new template needs no workflow change, and checks each template × framework on two lanes:

- **pinned**: the exact versions in the template's lockfile. This lane must always be green; a red here is ours to fix.
- **latest**: the same checks after moving every non-vendored dependency to its newest published version. Bump pull requests are not taken from that set: they carry only what [`upgrade-policy.json`](upgrade-policy.json) allows (no automatic majors, `0.x` minors count as majors, `@types/node` stays on the runtime major, runtime and tooling in separate PRs), and CI is dispatched on each bump commit ([docs/latest-lane.md](docs/latest-lane.md)). When latest is red and pinned is green, the workflow opens one issue named `upstream break: <package>@<version> breaks <template>/<framework>` and closes it when latest passes again. A drill forces a known-bad version to prove this path: `gh workflow run nightly.yml -f inject_drift=viem@1.0.0`.

Each lane runs:

1. `npm ci` from the npm registry only, with install scripts off;
2. `npm run typecheck`;
3. `npm start -- --mode fixture` — recorded fixtures, no network, no key;
4. `npm test`;
5. `npm run fork-check` against an anvil fork of Base at block 51800000, for templates that define one (`base-guarded-trader`, `treasury-monitor`): exact reads through the kit, and for the trader a transaction simulation and the policy pre-flight's answers. Nothing is broadcast. A template without a `fork-check` script has no fork step, and its result says so rather than counting a skipped step as a pass;
6. a custody check of the template's dependencies with [`satohubai/preflight-action`](https://github.com/satohubai/preflight-action).

## status.json

One entry per template × framework × lane (`pinned` or `latest`):

| Field | Meaning |
|---|---|
| `last_run` | the date of the most recent nightly run |
| `last_green` | the most recent date every check passed; `null` if never |
| `result` | `green`, `red` (a check failed) or `error` (the run left no result) |
| `failing_step` | the first check that failed, or `null` |
| `log_excerpt` | the last 40 lines of that check's output |
| `resolved` | the exact package versions the run installed |
| `held` | latest cells only: `[{ pkg, pinned, latest, reason }]`, each version the latest lane tested that the update policy keeps out of bump PRs |
| `history` | the last 30 runs as `{ date, result }` |

`badges/<template>-<framework>.json` is the same date in shields.io endpoint format.

A green entry means the template passed tonight's checks on that date. It is not a security review, not a statement that the template is fit for your use, and it says nothing about returns. The status job commits these files to `main` daily; that commit also keeps GitHub from disabling the schedule after 60 days without activity.

## Sato Status: third-party actions

`.github/workflows/actions-status.yml` runs every night at 07:23 UTC, an hour after the templates, and checks the onchain actions agents reach for most — from other projects, plus the Sato Kit's own core five as the reference consumer. Checks read Base and Ethereum (anvil forks at pinned blocks) and Solana (public mainnet reads); each entry names its `chain`. The list, and how each is checked, is [`scripts/actions-catalog.mjs`](scripts/actions-catalog.mjs). Every check runs with no secrets.

Per action, each night:

1. **conformance** — one read-only call: against an anvil fork of Base at block 51800000 or Ethereum at block 23000000 (balances and allowances are compared with the fork's own `eth_call`), or a public read with a fixed expected shape. Never a write, never a key. AgentKit actions are handed a read-only wallet provider that can only read; anything that tries to sign or send throws;
2. **schema lint** — the tool's input and output schemas through the portable rules (`scripts/lib/oda-lint.mjs`, vendored from Sato Hub), plus what each host does with the tool as published: OpenAI (name characters, schema root), Cursor (tool budget), Claude (name characters, schema root, description length). Findings are reported, never a failure;
3. **custody** — Sato Check's three answers for the action's source (`GET https://satohub.ai/api/check`), as returned. `unknown` stays `unknown`;
4. **description drift** — the sha256 of the tool description, compared with the previous night.

Installs come from `registry.npmjs.org` only, with install scripts off, and the lockfile is checked afterwards. Third-party servers and libraries run in child processes whose environment is `PATH` and `HOME` only, each inside a time box, and are killed when it closes. AgentKit's per-call analytics post is answered locally rather than sent.

### actions-status.json

`sato.action-status/v1`, one entry per action:

| Field | Meaning |
|---|---|
| `id` | `<source kind>:<name>` |
| `source` | `kind` (`agentkit-provider`, `protocol-mcp`, `skill`, `base-mcp-plugin`, `sato-kit`), `package`, `version`, `repo_url` |
| `checks.conformance` | `pass`, `fail` or `not_run`, with the step and detail of a failure |
| `checks.schema_lint` | `pass`, `findings` or `not_run`, with `hosts.openai` / `hosts.cursor` / `hosts.claude` findings and the portable-rule findings |
| `checks.custody` | `answered`, `unknown` or `not_run`, with `takes_key`, `key_leaves`, `moves_funds` and the Sato Check link |
| `checks.description_drift` | `first_seen`, `unchanged` or `changed` (`not_run` when the description could not be read), with both digests |
| `result` | `green` (conformance passed), `red` (it failed upstream) or `error` (the run failed on our side, or left no result) |
| `failing_step`, `upstream_version` | on a red, the step that failed and the version it ran against |
| `last_green`, `history` | as in `status.json` |

A green entry means the action passed tonight's checks on that date. It is not a security review and not a statement that the action is fit for your use.

## Updating the kit

Until `@satohub/kit` is published to npm, each template vendors a preview tarball in `vendor/`. `scripts/vendor-kit.sh <ref>` rebuilds it from `satohubai/sato-hub-integrations` at that ref.

Licensed MIT.
