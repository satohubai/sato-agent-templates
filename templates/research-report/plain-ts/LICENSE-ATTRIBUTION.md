# Licences and attribution

## This template

`research-report` — MIT, © Sato Hub. Migrated from the Sato Hub first-party
recipe `onchain-research-report` 1.0.0 (MIT, © Sato Hub): the attribution gate
(`src/verify.ts`), the prompt, the provider rules and the fixture scenarios are
carried over; onchain reads made through the Sato Kit's `chain.read` are new,
and each becomes a source in the closed corpus.

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

## Model providers

A real run (fork or rpc mode) calls Anthropic's Messages API over `fetch`. That
is a paid third-party service governed by its own terms; this template does not
include, resell or warrant it, and it makes no call at all without
`ANTHROPIC_API_KEY` set by you. The model identifiers in `src/providers.ts` were
read from <https://platform.claude.com/docs/en/about-claude/models/overview> on
2026-09-20. Re-read that page before relying on them.

## What this template is not

It is not a fact-checker. It verifies that every finding is ATTRIBUTABLE to a
source in the corpus and that every number in one appears in a cited source. It
cannot tell you a source is correct, current or honest.
