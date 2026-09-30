# AGENTS.md — research-report (plain-ts)

Instructions for a coding agent working in this repository.

## Commands

- `npm ci` — install (exact pins; `@satohub/kit` comes from `vendor/`)
- `npm run typecheck`
- `npm test`
- `npm start -- --mode fixture` — the default run; fake provider, recorded reads, no network, no key

The kit is vendored: `@satohub/kit` 0.1.1 is installed from `vendor/`, a build of the source commit named in `vendor/README.md`. Rebuild it with `scripts/vendor-kit.sh <ref>` at the repository root; do not edit the tarball.

## Rules

- A model proposes; `src/verify.ts` decides. Never let model text reach the output without passing the gate, and never hide a rejection: it goes in `rejected` with its reason.
- Every onchain read goes through the kit's `chain.read` (`src/chain.ts`). Do not read the chain with viem directly, and do not add a signer, a private key variable, `kit.prepare` or `kit.execute`: this template holds no key and moves no funds.
- An unknown is not a finding. Keep them in separate arrays.
- Fixture mode always uses the fake provider, whether or not `ANTHROPIC_API_KEY` is set. Do not make it fall through to a real call.
- A missing key or a model that is not a candidate is a typed refusal; never substitute another model. `model_policy.evaluated` stays empty until a recorded evaluation exists.
- Action ids and input shapes live only in `src/kit-io.ts`.
- Fixture mode never uses the network: an unrecorded read becomes an unknown with the reason. Refresh `fixtures/rpc.json` with `--mode fork --record` against a fork at block 51800000.
- New dependencies: exact versions only, and update `sato.template.json` `template.upstream` when you pin a package listed there.
- Make no claim in code, comments or docs that a finding is true, verified or audited. The gate proves attribution, nothing more.
