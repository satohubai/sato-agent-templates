# AGENTS.md — x402-seller (plain-ts)

Instructions for a coding agent working in this repository.

## Commands

- `npm ci` — install (exact pins; `@satohub/kit` comes from `vendor/`)
- `npm run typecheck`
- `npm test`
- `npm start -- --mode fixture` — the default run; no network, no key
- `npm run fork-check` — needs anvil on `ANVIL_RPC_URL` forked from Base at block 51800000

The kit is vendored: `@satohub/kit` 0.1.1 is installed from `vendor/`, a build of the source commit named in `vendor/README.md`. Do not edit the tarball.

## Rules

- The seller receives. It holds no key and has no signer: do not add a private key variable, a signing call, `kit.prepare` or `kit.execute`. The only transaction send is `ForkFacilitator`, through anvil's unlocked account on a local fork.
- Settlement confirmation goes through the kit's `chain.read` (`src/confirm.ts`). A settlement the chain does not confirm stays `unconfirmed`.
- Prices are integer base-unit strings from `config.json`. Never convert them to a float, and never accept a payment for a different amount, asset, payee or network than the route's offer.
- Never settle before the API has answered 200; an error is never charged.
- Every refusal names its reason. Keep the reason ids stable; tests and the fixture scenarios use them.
- No mainnet network, mode or asset. `policy.json` keeps `unknown_verdict: refuse`.
- The listing file is written, never submitted. Do not add code that posts it anywhere.
- Fixture mode never uses the network. Refresh `fixtures/rpc.json` with `npm run fork-check -- --record`, never by loosening the matcher. Do not re-sign `fixtures/payments/` unless you also re-record.
- Action ids and input shapes live only in `src/kit-io.ts`.
- New dependencies: exact versions only, and update `sato.template.json` `template.upstream` when you pin a package listed there.

## What it does NOT do

- Hold a key, sign, or move funds outside a local fork or Base Sepolia.
- Run on mainnet.
- Publish or submit the discovery listing.
- Refund, or claim a settlement the chain did not confirm.
