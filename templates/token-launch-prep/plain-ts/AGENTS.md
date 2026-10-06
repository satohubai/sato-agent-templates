# AGENTS.md — token-launch-prep (plain-ts)

Instructions for a coding agent working in this repository.

## Commands

- `npm ci` — install (exact pins; `@satohub/kit` comes from `vendor/`)
- `npm run typecheck`
- `npm test`
- `npm start -- --mode fixture` — the default run; no network, no key
- `npm run fork-check` — needs anvil on `ANVIL_RPC_URL` forked from Base at block 51800000
- `npm run testnet-check` — needs `BASE_SEPOLIA_RPC_URL` (a public Base Sepolia RPC); no key

The kit is vendored: `@satohub/kit` 0.1.1 is installed from `vendor/`, a build of the source commit named in `vendor/README.md`. Rebuild it with `scripts/vendor-kit.sh <ref>` at the repository root; do not edit the tarball.

## Rules

- This template prepares and simulates. It never signs and never sends. Do not add a signer, a wallet client, a private key variable or input, `kit.prepare`, `kit.execute`, `sendTransaction`, `writeContract` or any broadcast step. `test/never-signs.test.ts` fails if one appears.
- The creator is the only reward recipient and admin, with 10000 bps. Do not add a recipient (no template, Sato Hub or referrer address). `test/rewards.test.ts` checks the split, the calldata and every address written in `src/`.
- Do not depend on `clanker-sdk`: it includes a signing path. Clanker addresses, ABI fragments and defaults live in `src/clanker.ts`, copied from clanker-sdk 4.2.19 with their source named; change them only from a primary source and update `test/clanker.test.ts`.
- `value` stays "0": no extension that takes ETH (dev buy) is built here.
- The summary is decoded from the calldata. Keep it that way, so the summary cannot drift from the bytes.
- A simulation that fails is reported as `ok: false` with the reason and the run exits 3. Never report a failure as a pass, and never sign a transaction whose simulation did not pass.
- Action ids and input shapes live only in `src/kit-io.ts`.
- Fixture mode never uses the network: an unrecorded RPC call is an error. Refresh recordings with `--mode fork --record` against a fork at block 51800000, and update `scripts/fork-expected.ts` and `test/fixture-run.test.ts` with the new token addresses.
- Keep `policy.json` a valid `sato.policy/v1` file (`npm test` checks it).
- New dependencies: exact versions only, and update `sato.template.json` `template.upstream` when you pin a package listed there.
- Wording: describe what the code does. Make no claim that a token, a launch or this code is safe, secure, audited or profitable, and never imply returns.
