# Licences and attribution

## This template

`treasury-monitor` — MIT, © Sato Hub. Migrated from the Sato Hub first-party
recipe `treasury-balance-monitor` 1.0.0 (MIT, © Sato Hub): the base-unit and USD
arithmetic, the config validator, the checkpoint rules and the transition-only
alert logic are carried over; the balance reads now go through the Sato Kit's
`chain.read` instead of calling viem directly.

You may keep, modify and run this template after you disconnect from Sato Hub.
Nothing in it calls a Sato Hub service; fixture mode contacts nothing at all.

## Dependencies

| Package | Version | Licence | Source |
|---|---|---|---|
| @satohub/kit | 0.1.0 (vendored preview, `vendor/`) | MIT | https://github.com/satohubai/sato-hub-integrations |
| viem | 2.56.9 | MIT | https://github.com/wevm/viem |
| tsx (dev) | 4.23.15 | MIT | https://github.com/privatenumber/tsx |
| typescript (dev) | 5.9.3 | Apache-2.0 | https://github.com/microsoft/TypeScript |
| @types/node (dev) | 22.20.4 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |

The exact resolved tree, with integrity hashes, is `package-lock.json`; that file
is the authoritative record.

## What this template is not

It is not audited, not certified and not a financial control. It reads public
chain state and reports what it read. A `null` in its output means the value was
not established — never that it is zero.
