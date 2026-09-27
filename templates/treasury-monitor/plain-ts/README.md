# treasury-monitor (plain TypeScript)

[![last green](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsatohubai%2Fsato-agent-templates%2Fmain%2Fbadges%2Ftreasury-monitor-plain-ts.json)](https://github.com/satohubai/sato-agent-templates/blob/main/status.json)

Reads the native and ERC-20 balances of a list of **public** addresses on Base through the Sato Kit's `chain.read` (`@satohub/kit`), reports each one in exact base units and exact native units, and fires a threshold alert when a holding crosses a floor or a ceiling — once per crossing, not once per run.

It holds no key, signs nothing and moves no funds. It reads.

> **The kit is a vendored preview.** `@satohub/kit` 0.1.0 is not on npm yet; `vendor/` holds a preview build (the source commit is in `vendor/README.md`) and `package.json` installs it from there.

The badge shows the last date this template passed the nightly checks in [`status.json`](https://github.com/satohubai/sato-agent-templates/blob/main/status.json): install, typecheck, the fixture run, the tests, a fork check at a pinned Base block and a dependency custody check. It is a dated result, not a review.

## Run it

```sh
npm ci
npm start -- --mode fixture   # the default; no network, no key
```

| Mode | Reads from | Key |
|---|---|---|
| `fixture` (default) | nothing: recorded RPC answers in `fixtures/rpc.json` | none |
| `fork` | `ANVIL_RPC_URL`, a local anvil fork of Base | none |
| `rpc` | an endpoint you name with `--rpc <url>` or `SATO_RPC_URL_BASE` (Base or Base Sepolia) | none |

Every mode writes `out/report.json` (shape in `schemas/output.json`); `source_kind` says which mode produced it and `read_at` names the block each chain was read at. Fixture mode also replays every `fixtures/scenarios/*.input.json` into `out/scenarios/`.

```sh
# your own list, read-only, against an RPC you choose
npm start -- --mode rpc --rpc https://mainnet.base.org --config my-treasury.json --checkpoint treasury.checkpoint.json
```

`--config` is validated against `schemas/input.json` before a single read, and every error is reported at once (a typo is named with its near-miss). `config.json` is a valid example.

### Fork

```sh
anvil --fork-url https://mainnet.base.org --fork-block-number 51800000 --port 8547 &
ANVIL_RPC_URL=http://127.0.0.1:8547 npm start -- --mode fork
ANVIL_RPC_URL=http://127.0.0.1:8547 npm run fork-check
```

`npm start -- --mode fork --record` refreshes `fixtures/rpc.json` with every RPC answer `config.json` and the scenarios need. In fixture mode an unrecorded read is reported as unknown with the reason; it never reaches the network.

## What the output means

| Field | Meaning |
|---|---|
| `base_units` | The exact integer the chain returned, as a string. Never a float. |
| `native` | The same number with the decimal point put in. Exact string arithmetic. |
| `price_usd` | The **unit** price from a `prices` entry in your config, with the `source` you named. `null` = none was supplied. |
| `value_usd` | base units × unit price, exact integer arithmetic, truncated to 6 dp. `null` when unpriced. |
| `total_usd` | `null` whenever **any** holding is unpriced, or when nothing was read. A partial sum is never presented as a total. |
| `unknowns` | Everything that could not be established, each with a reason. |
| `checkpoint` | Carry it into the next run (`--checkpoint <file>`). It is what makes an alert fire once per crossing. |

**`null` means "not established".** It is never a zero, a default or a stale last-known figure.

This template ships **no price source**. The example config counts USDC at 1.00 USD and says so in the `source` field: that is an assumption you chose, not a price read. Anything without a `prices` entry is reported without a valuation.

A missing checkpoint file is a cold start. A checkpoint file that exists and cannot be parsed is an error, because starting cold would re-fire every alert you have already had.

## policy.json

A `sato.policy/v1` file. This template prepares nothing and has no signer, so no intent ever reaches the pre-flight. The file is here so that a write you add later starts from a refusing default: `human_approval: true`, caps of 1 USD, `unknown_verdict: "refuse"`. The kit's pre-flight explains refusals; enforcement lives in a signer, and this template has none.

## What it does NOT do

- **It does not move funds.** There is no signer, no private key variable, and no call to `kit.prepare` or `kit.execute` anywhere in `src/` (`npm test` checks this).
- **It does not price anything.** A USD value appears only where your config supplied a price and named its source.
- **It does not read chains other than Base and Base Sepolia.** A holding on another chain is reported as unknown, never as zero.
- **It does not send alerts anywhere.** Alerts are in the report; wiring them to email or chat is yours.
- **It has not been audited** and is not a financial control. A green nightly result means the checks listed above passed on that date.

## Files

| Path | What |
|---|---|
| `src/agent.ts` | one pass: read → value → thresholds → report |
| `src/sources.ts` | balances through the kit's `chain.read` |
| `src/task.ts` | the monitor as a pure function of (input, source) |
| `src/units.ts` | exact base-unit and USD arithmetic |
| `src/config.ts` | command line, config validation, checkpoints |
| `src/runtime.ts` | builds the kit for each mode (no signer in any) |
| `src/kit-io.ts` | the kit action id and input shapes, in one place |
| `src/fixtures.ts` | the offline RPC transport; anything unrecorded throws |
| `scripts/fork-check.ts` | the nightly fork check at block 51800000 |
| `fixtures/` | recorded RPC answers and scenario inputs |
| `vendor/` | a preview build of `@satohub/kit`, until it is published to npm |
| `sato.template.json` | the `sato.template/v1` manifest |

## Credits

Migrated from the Sato Hub recipe `treasury-balance-monitor` (MIT). See `LICENSE-ATTRIBUTION.md`.
