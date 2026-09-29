# status (data branch)

This branch holds data only, no code. It is written by the nightly bots in
`satohubai/sato-agent-templates` (`.github/workflows/nightly.yml` and
`.github/workflows/actions-status.yml`):

- `status.json` — nightly template install/check results
- `actions-status.json` — GitHub Action checks
- `badges/<template>-<framework>.json` — shields.io endpoint badges

Code lives on `main`. Do not open pull requests against this branch.
