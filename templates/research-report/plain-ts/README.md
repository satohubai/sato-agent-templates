# research-report (plain TypeScript)

[![last green](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsatohubai%2Fsato-agent-templates%2Fmain%2Fbadges%2Fresearch-report-plain-ts.json)](https://github.com/satohubai/sato-agent-templates/blob/main/status.json)

Answers a question from a **closed corpus**: sources you supply, plus onchain reads the template makes through the Sato Kit's `chain.read` (`@satohub/kit`). Each read becomes one source whose text carries the exact value and the block it was read at. A model proposes findings; a deterministic gate decides which survive.

It holds no key, signs nothing and moves no funds. It reads, and it asks a model.

> **The kit is a vendored preview.** `@satohub/kit` 0.1.0 is not on npm yet; `vendor/` holds a preview build (the source commit is in `vendor/README.md`) and `package.json` installs it from there.

The badge shows the last date this template passed the nightly checks in [`status.json`](https://github.com/satohubai/sato-agent-templates/blob/main/status.json): install, typecheck, the fixture run, the tests and a dependency custody check. It is a dated result, not a review.

## Run it

```sh
npm ci
npm start -- --mode fixture   # the default; fake provider, recorded reads, no network, no key
```

| Mode | Chain reads from | Model | Key |
|---|---|---|---|
| `fixture` (default) | recorded RPC answers in `fixtures/rpc.json` | the **fake** provider, replaying each scenario's recorded reply | none |
| `fork` | `ANVIL_RPC_URL`, a local anvil fork of Base | Anthropic (`ANTHROPIC_API_KEY`) | no wallet key |
| `rpc` | an endpoint you name with `--rpc <url>` or `SATO_RPC_URL_BASE` | Anthropic (`ANTHROPIC_API_KEY`) | no wallet key |

Fixture mode replays every `fixtures/scenarios/*.input.json` into `out/scenarios/` and writes the `chain-read-cited` scenario (or `--scenario <name>`) to `out/report.json`. Fork and rpc modes read `config.json` (or `--config <file>`), validated against `schemas/input.json` before anything is read or sent.

```sh
ANTHROPIC_API_KEY=… npm start -- --mode rpc --rpc https://mainnet.base.org --config my-question.json
```

**Fixture mode always uses the fake provider** — not "when no key is set", always. A test lane that becomes a paid call the first time a shell exports a key is a lane nobody can trust or budget.

### Refreshing the recordings

```sh
anvil --fork-url https://mainnet.base.org --fork-block-number 51800000 --port 8547 &
ANVIL_RPC_URL=http://127.0.0.1:8547 npm start -- --mode fork --record
```

`--record` replays the scenarios (fake provider) against the fork and writes every RPC answer they needed into `fixtures/rpc.json`.

## A model proposes; the gate decides

`src/verify.ts` is deterministic — the same proposal against the same corpus is accepted or rejected identically. Three rules:

1. **Every citation must be a source in the corpus.** A finding citing anything else is rejected, not downgraded.
2. **Every number must appear in a cited source**, as a token in its text. A chain read's sentence carries the exact integer it returned, so "about 26000 USDC" is rejected when the read returned `25896806146` base units.
3. **An unknown is not a finding.** Separate arrays; they never mix.

Everything the gate refused is in `rejected`, with the reason. A chain read that could not be made is an unknown with the reason, never a source.

## Reading the output

`findings` are **attributable**, which is narrower than **true**. The gate proves nothing was invented beyond the corpus; it cannot tell you a supplied source is correct, current or honest. `sources_used` comes from the findings that survived, never from what the model claimed to use. `chain_reads` lists every read with its block, or the reason it failed.

## Models

`recommended` is `anthropic/claude-sonnet-5`; `candidates` also carries `anthropic/claude-haiku-4-5` (identifiers read from <https://platform.claude.com/docs/en/about-claude/models/overview> on 2026-09-20). **`evaluated` is empty**: no model has been evaluated against this template. A model that is not a candidate, or a missing key, gets a typed refusal (exit 3); nothing silently substitutes another model.

## policy.json

A `sato.policy/v1` file. This template prepares nothing and has no signer, so no intent ever reaches the pre-flight. The file is here so that a write you add later starts from a refusing default: `human_approval: true`, caps of 1 USD, `unknown_verdict: "refuse"`.

## What it does NOT do

- **It does not move funds.** There is no signer, no wallet key variable, and no call to `kit.prepare` or `kit.execute` anywhere in `src/` (`npm test` checks this). The only kit action it calls is `chain.read`, which refuses any function that is not `view` or `pure`.
- **It does not fetch sources.** The only text it cites is what you supply and what its chain reads return.
- **It does not check whether a source is true.** Attributable is not verified.
- **It does not read chains other than Base and Base Sepolia.**
- **It has not been audited.** A green nightly result means the checks listed above passed on that date. There is no fork check for this template: its chain reads are covered by the recorded fixtures, and the treasury-monitor fork check pins the same kit action at block 51800000.

## Files

| Path | What |
|---|---|
| `src/agent.ts` | one report: reads → model → gate → report |
| `src/chain.ts` | onchain reads through the kit's `chain.read`, as corpus sources |
| `src/verify.ts` | the attribution gate |
| `src/task.ts` | the report as a function of (input, model, reads) |
| `src/providers.ts` | the fake and Anthropic providers, and the model policy |
| `src/config.ts` | command line and input validation |
| `src/runtime.ts` | builds the kit for each mode (no signer in any) |
| `src/kit-io.ts` | the kit action id and input shapes, in one place |
| `src/fixtures.ts` | the offline RPC transport; anything unrecorded throws |
| `fixtures/` | recorded RPC answers and scenario inputs with recorded model replies |
| `vendor/` | a preview build of `@satohub/kit`, until it is published to npm |
| `sato.template.json` | the `sato.template/v1` manifest |

## Credits

Migrated from the Sato Hub recipe `onchain-research-report` (MIT). See `LICENSE-ATTRIBUTION.md`.
