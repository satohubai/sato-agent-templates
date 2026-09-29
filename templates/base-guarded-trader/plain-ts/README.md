# base-guarded-trader (plain TypeScript)

[![last green](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsatohubai%2Fsato-agent-templates%2Fstatus%2Fbadges%2Fbase-guarded-trader-plain-ts.json)](https://github.com/satohubai/sato-agent-templates/blob/status/status.json)

A TypeScript agent on Base. It reads market data (block, gas, the Chainlink ETH/USD feed), decides with a small `Model` interface, and runs every intent through the Sato Kit (`@satohub/kit`): quote, prepare an unsigned transaction, simulate it, and check it against `policy.json` before anything could be signed.

> **The kit is a vendored preview.** `@satohub/kit` 0.1.0 is not on npm yet; `vendor/` holds a preview build (the source commit is in `vendor/README.md`) and `package.json` installs it from there. When the kit is published, this template moves to the npm package at an exact version.

**The kit's pre-flight explains every refusal; enforcement lives in the signer.** `policy.json` is read in this process, so anyone who can edit the process can edit the policy. On testnet the managed wallet enforces its own policy where the key lives.

The badge shows the last date this template passed the nightly checks in [`status.json`](https://github.com/satohubai/sato-agent-templates/blob/status/status.json): install, typecheck, the fixture run, the tests, a fork check at a pinned Base block and a dependency custody check. It is a dated result, not a review.

## Run it

```sh
npm ci
npm start -- --mode fixture   # the default; no network, no key
```

| Mode | Talks to | Key | Can it execute? |
|---|---|---|---|
| `fixture` (default) | nothing: recorded RPC answers and recorded venue quotes in `fixtures/` | none | no |
| `fork` | `ANVIL_RPC_URL`, a local anvil fork of Base, plus live venue quotes | a throwaway key the kit generates in memory, funded with `anvil_setBalance`; never written to disk | no — the signer is wrapped so it cannot broadcast |
| `testnet` | Base Sepolia (`BASE_SEPOLIA_RPC_URL`) | a Coinbase CDP managed wallet; there is no raw-key option | only with `--execute` |

Mainnet is not offered by this template.

### Fork

```sh
anvil --fork-url https://mainnet.base.org --fork-block-number 51800000 --port 8547 &
ANVIL_RPC_URL=http://127.0.0.1:8547 npm start -- --mode fork
```

To refresh the fixtures, run `npx tsx scripts/record-fixtures.ts` and then `npm start -- --mode fork --record` against that fork. `--record` writes every RPC answer the run needed into `fixtures/rpc.json` and every venue request and response (Sato Swap in recommend and build-tx mode, LI.FI) into `fixtures/http/`. Recording builds intents for the fixed address `0x…dEaD` (no key is held for it here) so the recordings are reproducible; the venue calls are live and send the user-agent `sato-template/base-guarded-trader@0.1.0`. In fixture mode an unrecorded request throws; it never reaches the network.

### Testnet with a CDP wallet

1. Create a CDP API key and a wallet secret at https://portal.cdp.coinbase.com.
2. `npm install @coinbase/cdp-sdk` (it is not installed by default, so fixture and fork runs never load it).
3. Put `BASE_SEPOLIA_RPC_URL`, `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` and `CDP_WALLET_SECRET` in `.env` (names in `.env.example`; `.env` is gitignored).
4. `npm start -- --mode testnet` prepares and simulates. Add `--execute` to hand an intent that passed the pre-flight to the managed wallet.

Without those variables, testnet mode refuses to start.

## What one run does

1. **Read.** Block and gas price from the RPC; the Chainlink ETH/USD round through the kit's `chain.read`.
2. **Decide.** `MockModel` (deterministic, no network) proposes the configured trade and one deliberately oversized trade. Replace it with anything that implements `Model` in `src/model.ts`.
3. **Quote.** `swap.quote`. Sato Swap is the labelled default and a LI.FI quote with no Sato fee is shown alongside it, in request order and unranked. Each fee disclosure is printed word for word.
4. **Prepare.** `swap.prepare` builds the unsigned transaction (when the taker's allowance is short, that is the exact-amount approval, never an unlimited one); the kit simulates it and runs the pre-flight. The run prints the prepared intent: its id, one-sentence summary, simulation result, fee disclosure and every refusal as `REFUSED rule=<id> limit=<value> observed=<value>`.
5. **Report.** `out/report.json` (shape in `schemas/output.json`). The run exits non-zero if the oversized intent was not refused.

## Venue and fee

Sato Swap is the labelled default. Its fee is disclosed on every quote and printed verbatim, and a no-Sato-fee quote is shown alongside so you can compare. To skip Sato entirely, set `"venue": "direct"` in `config.json`; the kit then quotes LI.FI only and makes no Sato call.

### USD values for the caps

The USD caps need the trade's USD value. The kit uses a venue's own figure when the venue returns one (LI.FI does; the Sato Swap response does not). Where it has none, `src/pricing.ts` fills it from named sources before the kit's own pre-flight runs: USDC is counted at 1.00 USD (an assumption, not a price read) and WETH at the Chainlink ETH/USD answer the run read. "Spent today" is what this process executed today, so it is 0 in fixture and fork runs and does not survive a restart; the managed wallet's policy is what enforces a daily limit. Any other token stays unknown, and `unknown_verdict: "refuse"` refuses it.

## policy.json

A `sato.policy/v1` file:

| Field | Value |
|---|---|
| `network` | `fork` |
| `allow_chains` | `base`, `base-sepolia` |
| `allow_tokens` | USDC and WETH on Base, as `base:<address>` |
| `max_usd_per_trade` | 25 |
| `max_usd_per_day` | 100 |
| `max_slippage_bps` | 100 |
| `unknown_verdict` | `refuse` — a value the kit cannot read refuses; it never reads as fine |
| `intent_ttl_s` | 300 |

A refusal names its rule id, the limit and the value observed. The kit's pre-flight explains every refusal; enforcement lives in the signer.

## What it does NOT do

- **It never signs on mainnet.** Mainnet is not a mode here.
- **It signs only in two places:** on a local fork with a throwaway key the kit generates in memory (never written to disk, funded only with fork money), or on Base Sepolia with a managed CDP wallet. There is no raw-private-key path.
- **It builds and simulates a transaction on a fork, and never broadcasts it.** Fixture and fork runs never call `execute`; the fork signer is wrapped so a send throws.
- **The quote is not a fill.** Prices move between a quote and any trade.
- **The policy runs in this process.** It explains refusals before anything is signed. It is not a control on its own: enforcement lives in the signer and its native policy.
- **It does not decide anything well.** `MockModel` always proposes the same trades. It exists to show the path, not to trade.
- **It has not been audited.** This is a starting point. Read it before you build on it.
- **A green nightly result is not a security review.** It means the checks listed above passed on that date.

## Files

| Path | What |
|---|---|
| `src/agent.ts` | one pass: read → decide → quote → prepare → report |
| `src/model.ts` | the `Model` interface and `MockModel` |
| `src/runtime.ts` | builds the kit for each mode (signer, RPC, fetch) |
| `src/kit-io.ts` | the kit action ids and input shapes, in one place |
| `src/pricing.ts` | the USD facts for the caps, handed to the kit's pre-flight |
| `src/fixtures.ts` | the offline transport and fetch; anything unrecorded throws |
| `scripts/fork-check.ts` | the nightly fork check at block 51800000 (`npm run fork-check`) |
| `fixtures/` | recorded RPC answers and venue quotes |
| `vendor/` | a preview build of `@satohub/kit`, until it is published to npm |
| `sato.template.json` | the `sato.template/v1` manifest |

## Credits

Migrated from [satohubai/base-agent-starter](https://github.com/satohubai/base-agent-starter). MIT.
