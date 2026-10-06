# Licences and attribution

## This template

`token-launch-prep` — MIT, © Sato Hub.

You may keep, modify and run this template after you disconnect from Sato Hub.
Nothing in it calls a Sato Hub service; fixture mode contacts nothing at all, and
fork and rpc modes contact only the RPC you point them at.

## Copied from clanker-sdk (not a dependency)

`src/clanker.ts` carries values copied from clanker-sdk 4.2.19 (MIT,
https://github.com/clanker-devco/clanker-sdk): the Clanker v4 contract addresses
for Base and Base Sepolia, the `deployToken` ABI fragment and the factory's error
names, the locker, static-fee, pool-initialization and sniper-auction encodings,
the pool position presets, and the default static fee and sniper fee schedule.
The package itself is not installed.

## Dependencies

| Package | Version | Licence | Source |
|---|---|---|---|
| @satohub/kit | 0.1.1 (vendored preview, `vendor/`) | MIT | https://github.com/satohubai/sato-hub-integrations |
| viem | 2.57.2 | MIT | https://github.com/wevm/viem |
| tsx (dev) | 4.23.15 | MIT | https://github.com/privatenumber/tsx |
| typescript (dev) | 5.9.3 | Apache-2.0 | https://github.com/microsoft/TypeScript |
| @types/node (dev) | 22.20.5 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |

The exact resolved tree, with integrity hashes, is `package-lock.json`; that file
is the authoritative record.

## What this template is not

It is not audited and not a review of Clanker's contracts. It prepares an
unsigned transaction and reports a simulation; you decide whether to sign it.
