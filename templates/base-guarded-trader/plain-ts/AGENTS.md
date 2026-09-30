# AGENTS.md — base-guarded-trader (plain-ts)

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

- Every onchain action goes through the kit (`kit.read`, `kit.prepare`, `kit.execute`). Do not call viem write methods or a signer directly.
- `execute` takes `{ intent_id }` and nothing else. Never pass other keys.
- Fixture and fork runs never call `execute`. Do not add a mainnet mode.
- Never write a private key to disk or to `.env`. Fork mode generates a throwaway key in memory; testnet uses a managed CDP wallet.
- Keep `policy.json` a valid `sato.policy/v1` file (`npm test` checks it). Loosening a cap is a user decision, not a fix for a failing run.
- A refusal is output, not an error to suppress: it prints `rule`, `limit` and `observed`.
- Action ids and input shapes live only in `src/kit-io.ts`; they mirror each action descriptor's `input_schema`.
- Fixture mode never uses the network: an unrecorded RPC call or venue request throws. Refresh recordings with `--mode fork --record` (see README), never by loosening the matcher.
- New dependencies: exact versions only, and update `sato.template.json` `template.upstream` when you pin a package listed there.
- Make no claim in code, comments or docs that this agent is audited, risk-free or makes money.
