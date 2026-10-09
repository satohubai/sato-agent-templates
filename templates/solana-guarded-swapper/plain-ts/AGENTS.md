# AGENTS.md — solana-guarded-swapper (plain-ts)

Instructions for a coding agent working in this repository.

## Commands

- `npm ci` — install (exact pins, from the npm registry)
- `npm run typecheck`
- `npm test`
- `npm start -- --mode fixture` — the default run; no network, no key
- `npm run preflight` — checks installed dependencies against their Sato Check receipts (reads npm tarballs and Solana; no key)

## Rules

- **There is no signer, and none is to be added here.** Do not call `execute`, `sendTransaction`, `signTransaction` or any signer, and do not load a key, a keypair file or a mnemonic. The run ends at an unsigned transaction in `out/unsigned-<n>.json`. `npm test` fails if `src/` or `scripts/` gain such a call.
- Every onchain action goes through the kit (`kit.read`, `kit.prepare`). Action ids and input shapes live only in `src/kit-io.ts`; they mirror each action descriptor's `input_schema`.
- `config.json` takes a public address only. Never write a key to disk, to `.env` or into a log.
- Keep `policy.json` a valid `sato.policy/v1` file (`npm test` checks it). Loosening a cap is a user decision, not a fix for a failing run. `unknown_verdict` stays `refuse`.
- A refusal is output, not an error to suppress: it prints `rule`, `limit` and `observed`.
- The daily cap counts swaps this agent prepared today (`src/spend.ts`), signed or not. Do not make it count only executed swaps.
- Fixture mode never uses the network: an unrecorded RPC call or venue request throws. Refresh recordings with `--mode live --accept-mainnet-risk --record` (see README), never by loosening the matcher.
- `--mode live` needs `"network": "mainnet"` in `policy.json` and `--accept-mainnet-risk`. Do not make either a default, and do not add a way around them.
- `npm run preflight` exits 0 unless `--strict` is given. It reads; it never writes to a chain. The only RPC methods it sends are `getMultipleAccounts` (receipts) and none other.
- A receipt DESCRIBES a build on a date. In every output and doc use the words Sato Check uses ("same build as recorded", "different build", "no reading for this version"). Never write safe, secure, trusted, verified, passed or audited about a package.
- Do not import code from the Sato Hub app. `src/preflight/` reads receipts with `@solana/kit` and the SAS account layout, independently.
- `@solana/kit` stays at 8.x here. Do not add it to a template that uses Coinbase AgentKit (its `@coinbase/cdp-sdk` pulls kit 5.x and npm refuses the tree).
- New dependencies: exact versions only, and update `sato.template.json` `template.upstream` when you pin a package listed there.
- Make no claim in code, comments or docs that this agent is audited, risk-free or makes money.
