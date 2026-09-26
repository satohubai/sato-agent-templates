# Sato agent templates

Onchain-agent templates built on the Sato Kit (`@satohub/kit`). Every template here is rebuilt and checked every night, and the result is committed to `status.json`.

- Templates live at `templates/<id>/<framework>/`.
- The default network is a local fork. No template signs anything on mainnet unless you ask it to.
- No secrets live in this repository. The nightly checks run with none.

A green result means the template installed, typechecked, ran on fixtures and passed its tests on the date shown. It is not a security review and says nothing about returns.

Licensed MIT.
