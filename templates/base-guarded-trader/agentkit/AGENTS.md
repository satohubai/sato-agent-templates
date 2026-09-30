# AGENTS.md — base-guarded-trader (agentkit)

Instructions for a coding agent working in this repository.

## Commands

- `npm ci` — install (exact pins; `@satohub/kit` comes from `vendor/`)
- `npm run typecheck`
- `npm test`
- `npm start -- --mode fixture` — the default run; no network, no key
- `npm run fork-check` — needs anvil on `ANVIL_RPC_URL` forked from Base at block 51800000

The kit is vendored: `@satohub/kit` 0.1.1 is installed from `vendor/`, a build of the source commit named in `vendor/README.md`. Rebuild it with `scripts/vendor-kit.sh <ref>` at the repository root; do not edit the tarball.

## Sato OS hand-off (optional)

- `npm run sato-os:attach -- --url <Sato OS URL> --wallet <0x address>` stores the agent's token in `.sato/sato-os.json`. Never print, log or commit that file.
- `npm start -- --mode sato-os` (add `--data fixture` offline) proposes allowed intents to Sato OS through `proposeIntent` from `@satohub/kit/sato-os` (`src/sato-os.ts`). Refused intents are never proposed.
- In this mode the agent never signs or executes. Do not add a signer or an `execute` call to the sato-os path; Sato OS signs after a person approves.

## Rules

- The kit reaches Coinbase AgentKit through ONE action provider, `satoKitActionProvider` from `@satohub/kit/agentkit`. Do not write AgentKit actions that duplicate kit tools, and do not add AgentKit action providers that sign or send (wallet, ERC-20 transfer, swap) beside it.
- Every onchain action goes through the kit's tools (`chain_read`, `swap_quote`, `swap_prepare`, `execute`). Do not call viem write methods, a wallet provider's `sendTransaction` or a signer directly.
- `execute` takes `{ intent_id }` and nothing else. Never pass other keys.
- Fixture and fork runs never execute: build the provider WITHOUT `approve` there. Pass `approve` only on testnet with `--execute`, and keep it a person's answer, never code that returns true.
- Do not add a mainnet mode. Fork mode generates a throwaway key in memory; testnet uses a CDP smart wallet (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET`). Never write a private key to disk or to `.env`.
- Keep the AgentKit analytics switch in `src/agentkit.ts`. Fixture mode must make no network call (`test/agentkit.test.ts` checks it).
- Keep `policy.json` a valid `sato.policy/v1` file (`npm test` checks it). Loosening a cap is a user decision, not a fix for a failing run.
- A refusal is output, not an error to suppress: it prints `rule`, `limit` and `observed`.
- Kit action ids and input shapes live only in `src/kit-io.ts`; AgentKit tool names only in `TOOLS` in `src/agentkit.ts`.
- Fixture mode never uses the network: an unrecorded RPC call or venue request throws. Refresh recordings with `--mode fork --record`, never by loosening the matcher.
- New dependencies: exact versions only, and update `sato.template.json` `template.upstream` when you pin a package listed there. `viem` stays on the version `@coinbase/agentkit` pins, so there is one viem.
- Make no claim in code, comments or docs that this agent is audited, risk-free or makes money.

## What it does NOT do

- It never signs on mainnet.
- It never executes in fixture or fork mode; on testnet only with `--execute` and a typed `yes`.
- It never broadcasts on the fork: the signer throws on send.
- It does not register a CDP policy for the wallet; that is the owner's step.
- A quote is not a fill, and `MockModel` is not a trading strategy.
- It has not been audited.
