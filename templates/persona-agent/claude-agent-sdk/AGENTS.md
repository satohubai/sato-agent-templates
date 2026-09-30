# AGENTS.md — persona-agent (claude-agent-sdk)

Instructions for a coding agent working in this repository.

## Commands

- `npm ci` — install (exact pins; `@satohub/kit` comes from `vendor/`)
- `npm run typecheck`
- `npm test`
- `npm start -- --mode fixture` — the default run; no network, no token, no key

The kit is vendored: `@satohub/kit` 0.1.1 is installed from `vendor/`, a build of the source commit named in `vendor/README.md`. Rebuild it with `scripts/vendor-kit.sh <ref>` at the repository root; do not edit the tarball.

## Rules

- Every wallet action goes through the kit (`kit.read`, `kit.prepare`, `kit.execute`). Do not call viem write methods or a signer directly.
- The model gets `wallet_quote` and `wallet_prepare` only. Never give it an execute or signing tool.
- `execute` takes `{ intent_id }` and nothing else, runs on testnet only with `--allow-execute`, and the signer is wrapped in `humanApprove`.
- Fixture and fork runs never call `execute`. Do not add a mainnet mode.
- Fixture mode never uses the network: connectors are fakes, the model is scripted, RPC and venue answers are recordings. An unrecorded call throws.
- Connector tokens come from the environment only. Never log them, never write them to a file.
- Keep `policy.json` a valid `sato.policy/v1` file with `unknown_verdict: refuse`. Loosening a cap is a user decision, not a fix for a failing run.
- A refusal is output, not an error to suppress: it prints `rule`, `limit` and `observed`.
- New dependencies: exact versions only; update `sato.template.json` `template.upstream` when you pin a package listed there.
- Make no claim in code, comments or docs that this agent is audited, risk-free or makes money.

## What it does NOT do

- No mainnet, no model-initiated signing, no execution in fixture or fork, no private key on disk, no ElizaOS dependency.
