# Licences and attribution

## This template

`solana-guarded-swapper` — MIT, © Sato Hub.

You may keep, modify and run this template after you disconnect from Sato Hub.
Fixture mode contacts nothing at all. Live mode contacts the Solana RPC you
name, Jupiter (`lite-api.jup.ag`) and, for the default venue, Sato Route
(`satohub.ai`). `npm run preflight` contacts the npm registry, the Solana RPC
for receipts and, while the receipt addresses are not set, the Sato Hub API.

## Account layouts (not a dependency)

`src/preflight/sas.ts` reads accounts of the Solana Attestation Service
(https://github.com/solana-foundation/solana-attestation-service, MIT,
© Solana Foundation): the attestation and schema layouts and the data types of a
schema. The code is written here against those layouts; the client package
`@solana/attestation` is not installed. `test/fixtures/sas-golden.json` holds
account bytes produced once by its 2.1.0 encoders, to test the reader.

## Dependencies

| Package | Version | Licence | Source |
|---|---|---|---|
| @satohub/kit | 0.1.1 | MIT | https://github.com/satohubai/sato-hub-integrations |
| @solana/kit | 8.4.0 | MIT | https://github.com/anza-xyz/kit |
| viem | 2.57.2 | MIT | https://github.com/wevm/viem |
| tsx (dev) | 4.23.15 | MIT | https://github.com/privatenumber/tsx |
| typescript (dev) | 5.9.3 | Apache-2.0 | https://github.com/microsoft/TypeScript |
| @types/node (dev) | 22.20.5 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |

`viem` is a peer dependency of the kit and is installed for it; this template
does not use it directly. The exact resolved tree, with integrity hashes, is
`package-lock.json`; that file is the authoritative record.

## What this template is not

It is not audited. It prepares an unsigned transaction and reports a
simulation; you decide whether to sign it. A receipt describes what Sato Check
found in one build on one date; it is not a review of that package.
