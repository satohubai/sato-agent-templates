# base-guarded-trader (Vercel AI SDK)

[![last green](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsatohubai%2Fsato-agent-templates%2Fstatus%2Fbadges%2Fbase-guarded-trader-ai-sdk.json)](https://github.com/satohubai/sato-agent-templates/blob/status/status.json)

The same agent as [`base-guarded-trader/plain-ts`](../plain-ts), hosted by the [Vercel AI SDK](https://github.com/vercel/ai) (`ai`). It reads market data on Base (block, gas, the Chainlink ETH/USD feed) and hands the Sato Kit's tools to a `generateText` tool loop as an AI SDK `ToolSet`, built by `satoKitTools` from `@satohub/kit/ai-sdk`. Every intent is quoted, prepared as an unsigned transaction, simulated and checked against `policy.json` before anything could be signed. `swap_prepare`, `x402_prepare` and `execute` carry the AI SDK approval flag (`needsApproval: true`; `satoKitToolApproval` gives the same set as a `toolApproval` config), so `generateText` stops with a `tool-approval-request` before they run and a person decides; the answer goes back as a `tool-approval-response` message.

The model only sees the kit's tools. It holds no key and builds no transaction itself.

> **The kit is vendored.** `@satohub/kit` 0.1.1 is installed from `vendor/`, a build of the source commit named in `vendor/README.md`; `package.json` installs it from there. When the kit is published, this template moves to the npm package at an exact version.

**The kit's pre-flight explains every refusal; enforcement lives in the signer.** `policy.json` is read in this process, so anyone who can edit the process can edit the policy. On testnet the managed wallet enforces its own policy where the key lives.

The badge shows the last date this template passed the nightly checks in [`status.json`](https://github.com/satohubai/sato-agent-templates/blob/status/status.json): install, typecheck, the fixture run, the tests, a fork check at a pinned Base block and a dependency custody check. It is a dated result, not a review.

## Run it

```sh
npm ci
npm start -- --mode fixture   # the default; no network, no key, no model API
```

### Two models

| `--model` | What drives the agent | Needs |
|---|---|---|
| `scripted` (default) | `scriptedModel` (`src/host.ts`), the AI SDK's own `MockLanguageModelV4` from `ai/test`, answering from a fixed list of tool calls (`scriptedNext` in `src/model.ts`): quote, prepare, prepare the over-cap intent, then ask to execute. It runs inside the SDK's own `generateText` loop, so the tools, the approval requests and the resume are the real ones. No model API is called and telemetry is off. | nothing |
| `live` | a real model through the same `generateText` loop (`src/live.ts`), with only the kit's tools. The model is a provider string of the form `<provider>/<model>` (for example `openai/gpt-5`), passed with `--model-id` and resolved by the AI SDK's default provider (the Vercel AI Gateway). There is no default model. Each approval request asks you `y` or `N` at the terminal; with no terminal the answer is no. | `AI_GATEWAY_API_KEY` |

```sh
AI_GATEWAY_API_KEY=... npm start -- --mode fixture --model live --model-id openai/gpt-5   # recorded chain data, a real model
```

To use a provider package directly instead of the gateway (for example `@ai-sdk/openai`), install it at an exact version and pass its model object to `runAgent` in `src/live.ts`; the tools and the approval loop do not change.

In a scripted run, `swap_prepare` is approved by the script (it builds an unsigned intent and signs nothing) and `execute` is rejected, so it never runs. On testnet with `--execute`, the run asks you before `execute`. Outside testnet `--execute`, `execute` is rejected without asking, whichever model runs.

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
2. **Decide.** `MockModel` (deterministic, no network) proposes the configured trade and one deliberately oversized trade. With `--model live`, the model is given those two trades in its prompt and makes the tool calls itself.
3. **Quote.** The `swap_quote` tool (`swap.quote`). Sato Swap is the labelled default and a LI.FI quote with no Sato fee is shown alongside it, in request order and unranked. Each fee disclosure is printed word for word.
4. **Prepare.** The `swap_prepare` tool (`swap.prepare`), after the approval request is answered, builds the unsigned transaction (when the taker's allowance is short, that is the exact-amount approval, never an unlimited one); the kit simulates it and runs the pre-flight. The run prints the prepared intent: its id, one-sentence summary, simulation result, fee disclosure and every refusal as `REFUSED rule=<id> limit=<value> observed=<value>`.
5. **Execute, asked.** The run asks to `execute` the intent that passed. `generateText` stops with an approval request; in fixture and fork runs nobody approves, so the call is denied and nothing runs.
6. **Report.** `out/report.json` (shape in `schemas/output.json`), including the agent's tool list, the tools that need approval, the calls made and every approval decision. The run exits non-zero if the oversized intent was not refused.

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

## Run it for real with Sato OS

Sato OS is Sato Hub's paid, self-hosted runtime. You run it on your own machine or server. It holds the agent's wallet, shows each proposed action to a person, and signs only what that person approves. This template can hand its intents to Sato OS instead of signing anything itself. The hand-off is optional; every other mode works without it.

```bash
# 1. Attach this agent to your Sato OS. Name the wallet Sato OS holds for it (an address, never a key).
npm run sato-os:attach -- --url https://your-sato-os.example --wallet 0xYourAgentWallet
#    The agent's scoped token is stored in .sato/sato-os.json (mode 0600, gitignored) and never printed.

# 2. Run a pass. Reads Base through BASE_RPC_URL (read-only); intents are built for the attached wallet.
BASE_RPC_URL=https://mainnet.base.org npm start -- --mode sato-os

# Offline rehearsal over the shipped recordings (attach with --wallet 0x000000000000000000000000000000000000dEaD):
npm start -- --mode sato-os --data fixture
```

What `--mode sato-os` does:

- Quotes, prepares, simulates and pre-flights every intent with the kit, exactly as the other modes do.
- Files each intent the pre-flight **allowed** as a proposal in Sato OS (`sato_os_create_action_proposal`), with the prepared intent attached. The run ends there; the report lists each proposal id and its status.
- Sends nothing for a **refused** intent. It is recorded as "not proposed" with the rules that refused it.

What it does not do:

- It holds no key, signs nothing and broadcasts nothing. Approval and signing happen inside Sato OS, under Sato OS's own policy, after a person says yes.
- It does not lift this template's policy. The kit's pre-flight still runs first; an intent on Base mainnet is refused (`network_mainnet_not_enabled`) until you set `"network": "mainnet"` in `policy.json` yourself.
- A proposal is not a trade. Sato OS may decline it, the person may reject it, and the intent expires after `intent_ttl_s`.

## What it does NOT do

- **It never signs on mainnet.** Mainnet is not a mode here. With `--mode sato-os` it signs nothing at all; Sato OS signs what a person approves there.
- **It signs only in two places:** on a local fork with a throwaway key the kit generates in memory (never written to disk, funded only with fork money), or on Base Sepolia with a managed CDP wallet. There is no raw-private-key path.
- **It builds and simulates a transaction on a fork, and never broadcasts it.** Fixture and fork runs never call `execute`; the fork signer is wrapped so a send throws.
- **The quote is not a fill.** Prices move between a quote and any trade.
- **The policy runs in this process.** It explains refusals before anything is signed. It is not a control on its own: enforcement lives in the signer and its native policy.
- **It does not decide anything well.** `MockModel` always proposes the same trades, and the scripted model always makes the same calls. They exist to show the path, not to trade.
- **The default run calls no model API.** Fixture mode never calls a model API and exports no telemetry; only `--model live` calls one, and only with your key.
- **The approval request is not the enforcement.** It makes `generateText` stop before a call; the policy explains; the signer enforces.
- **A model's words are not a result.** In a live run, read the printed intent and refusals, not the model's summary of them.
- **It has not been audited.** This is a starting point. Read it before you build on it.
- **A green nightly result is not a security review.** It means the checks listed above passed on that date.

## Files

| Path | What |
|---|---|
| `src/agent.ts` | one pass: read → decide → agent (quote → prepare → ask to execute) → report |
| `src/host.ts` | the kit's AI SDK tools, the `generateText` loop that answers approval requests, and `scriptedModel` |
| `src/live.ts` | `--model live`: the provider string, the live prompt and the terminal approval |
| `src/model.ts` | the `Model` interface, `MockModel` and the scripted turn list |
| `src/runtime.ts` | builds the kit for each mode (signer, RPC, fetch) |
| `src/sato-os.ts` | the optional Sato OS hand-off: attach, then propose allowed intents |
| `scripts/sato-os-attach.ts` | `npm run sato-os:attach` |
| `src/kit-io.ts` | the kit action ids and input shapes, in one place |
| `src/pricing.ts` | the USD facts for the caps, handed to the kit's pre-flight |
| `src/fixtures.ts` | the offline transport and fetch; anything unrecorded throws |
| `scripts/fork-check.ts` | the nightly fork check at block 51800000 (`npm run fork-check`) |
| `fixtures/` | recorded RPC answers and venue quotes |
| `vendor/` | a preview build of `@satohub/kit`, until it is published to npm |
| `sato.template.json` | the `sato.template/v1` manifest |

## Credits

Migrated from [satohubai/base-agent-starter](https://github.com/satohubai/base-agent-starter). This template's code is MIT. `ai` is Apache-2.0.
