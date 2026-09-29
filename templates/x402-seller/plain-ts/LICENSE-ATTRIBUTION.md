# Licences and attribution

## This template

`x402-seller` — MIT, © Sato Hub. The x402 v2 message shapes follow the x402
protocol specification and the `@x402/core` / `@x402/extensions` type
definitions (Apache-2.0, https://github.com/x402-foundation/x402); no code from
those packages is included.

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

The exact resolved tree, with integrity hashes, is `package-lock.json`.

## What this template is not

It is not audited, not certified and not a payment processor. It checks a
payment against its own offer, hands it to a facilitator, and reports what the
chain confirms.
