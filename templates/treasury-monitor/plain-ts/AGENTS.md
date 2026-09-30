# AGENTS.md — treasury-monitor (plain-ts)

Instructions for a coding agent working in this repository.

## Commands

- `npm ci` — install (exact pins; `@satohub/kit` comes from `vendor/`)
- `npm run typecheck`
- `npm test`
- `npm start -- --mode fixture` — the default run; no network, no key
- `npm run fork-check` — needs anvil on `ANVIL_RPC_URL` forked from Base at block 51800000

The kit is vendored: `@satohub/kit` 0.1.1 is installed from `vendor/`, a build of the source commit named in `vendor/README.md`. Rebuild it with `scripts/vendor-kit.sh <ref>` at the repository root; do not edit the tarball.

## Rules

- This template reads. Every chain read goes through the kit's `chain.read` (`src/sources.ts`); do not call viem read or write methods for balances directly.
- It holds no key and has no signer. Do not add one, a private key variable, `kit.prepare` or `kit.execute` to this template; an agent that moves funds starts from `base-guarded-trader`.
- `null` means not established. Never replace an unread balance or an unpriced holding with `0`, and never present a partial sum as `total_usd`.
- Balances are integer base-unit strings. Never convert them to a float.
- A threshold fires on the transition only; keep the checkpoint rules in `src/config.ts` and `src/task.ts`.
- Keep `policy.json` a valid `sato.policy/v1` file (`npm test` checks it).
- Action ids and input shapes live only in `src/kit-io.ts`.
- Fixture mode never uses the network: an unrecorded RPC call is reported as unknown with the reason. Refresh recordings with `--mode fork --record` (see README), never by loosening the matcher.
- New dependencies: exact versions only, and update `sato.template.json` `template.upstream` when you pin a package listed there.
- Make no claim in code, comments or docs that this monitor is audited, a financial control, or that a value it prints is a price it did not read.
