# AGENTS.md — base-guarded-trader (plain-ts)

Instructions for a coding agent working in this repository.

## Commands

- `npm ci` — install (exact pins; `@satohub/kit` comes from `vendor/`)
- `npm run typecheck`
- `npm test`
- `npm start -- --mode fixture` — the default run; no network, no key
- `npm run fork-check` — needs anvil on `ANVIL_RPC_URL` forked from Base at block 51800000

The kit is a vendored preview: `@satohub/kit` 0.1.0 is installed from `vendor/` until it is published to npm. Rebuild it with `scripts/vendor-kit.sh <ref>` at the repository root; do not edit the tarball.

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
