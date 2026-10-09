# solana-guarded-swapper (plain TypeScript)

[![last green](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsatohubai%2Fsato-agent-templates%2Fstatus%2Fbadges%2Fsolana-guarded-swapper-plain-ts.json)](https://github.com/satohubai/sato-agent-templates/blob/status/status.json)

A TypeScript agent on Solana. It watches a wallet and, when the SOL price has fallen past a threshold you set, prepares a Jupiter SOL to USDC swap under a daily cap from `policy.json`. It builds the **unsigned** transaction, simulates it with `simulateTransaction`, checks it against the policy, writes it to `out/unsigned-1.json` and stops. **It has no signer and holds no key.** You read the transaction and sign it with your own wallet, or you don't.

It uses the Sato Kit's Solana actions (`@satohub/kit` 0.1.1): `solana.read`, `solana.swap.quote` and `solana.swap.prepare`.

It also ships `npm run preflight`: for each installed dependency that handles keys, it checks the exact npm tarball you installed against that build's Sato Check receipt, which is recorded on Solana. See [Preflight](#preflight-what-do-my-dependencies-do-with-keys).

The badge shows the last date this template's nightly checks all came back green in [`status.json`](https://github.com/satohubai/sato-agent-templates/blob/status/status.json): install, typecheck, the fixture run, the tests and a dependency custody check. It is a dated result, not a review.

## Quickstart

```sh
npx create-sato-agent@0.1 "swap SOL to USDC on Jupiter on Solana when the price drops, under a daily cap"
```

Naming Solana in the goal selects this template. `--chain solana` does the same once the `create-sato-agent` release you run lists `solana` as a chain. Then, in the new folder:

```sh
npm ci
npm run preflight                  # what do my dependencies do with keys? (reads Solana, needs no key)
npm start -- --mode fixture        # the default run: no network, no key
```

## Run it

| Mode | Talks to | Key | Can it sign or send? |
|---|---|---|---|
| `fixture` (default) | nothing: recorded Solana RPC answers and recorded Jupiter / Sato Route responses in `fixtures/` | none | no |
| `live` | Solana mainnet through `SOLANA_RPC_URL` (read calls and `simulateTransaction` only), plus live Jupiter and Sato Route requests | none | no |

`live` needs two things from you, on purpose. See [Mainnet](#mainnet).

Exit codes: 0 when the run finished (a swap prepared, or none was due), 1 when a cap check did not refuse what it must, 2 for a usage or config error.

## What one run does

1. **Read the wallet.** `solana.read` (`sol_balance`) for the wallet in `config.json`.
2. **Read the price.** A Jupiter quote (`solana.swap.quote`, venue `direct`) for the amount that would be sold. The price is the USDC out per SOL in, with USDC counted as 1 USD. It is a quote, not an oracle, and it includes the route's price impact.
3. **Decide.** Has SOL fallen `drop_pct` percent or more below the reference? The reference is `reference_price_usd` from `config.json`, or else the highest price this agent has seen (kept in `.sato/state.json`). With neither, the first run records the price and prepares nothing. If selling `sell_sol` would leave the wallet below `keep_sol`, the run skips and says why.
4. **Quote.** Sato Route is the labelled default venue and a Jupiter quote with no Sato fee is shown alongside it, in request order and unranked. Each fee disclosure is printed word for word.
5. **Prepare and simulate.** `solana.swap.prepare` asks Jupiter for the unsigned swap transaction, the kit simulates it (`simulateTransaction`, no signature needed), and runs the policy pre-flight. A swap whose simulation fails, or could not run, is refused. The run prints the intent: id, one-sentence summary, simulation, fee disclosure and every refusal as `REFUSED rule=<id> limit=<value> observed=<value>`.
6. **Stop.** A swap that cleared the pre-flight is written to `out/unsigned-<n>.json` with its simulation and policy result. The report is `out/report.json` (shape in `schemas/output.json`). It always says `"signed": false, "broadcast": false`.

In fixture mode the run also makes two cap checks, so you can see the pre-flight refuse without waiting for a drop: the same swap a second time the same day (the daily cap) and a 10 SOL swap (the per-swap caps). The run exits 1 if either is not refused. Neither is ever written out to sign.

## Mainnet

Jupiter quotes and swaps Solana mainnet only, so `live` mode is a mainnet run. It still signs and sends nothing. What it does is read your wallet's real balance, ask real venues for real quotes, and build a real, unsigned transaction that you could sign. Starting it takes two deliberate steps:

1. Change `"network": "fork"` to `"network": "mainnet"` in `policy.json`.
2. Run it with `--accept-mainnet-risk`:

```sh
SOLANA_RPC_URL=https://your-rpc.example npm start -- --mode live --accept-mainnet-risk
```

Put your **public** address in `config.json` as `"wallet"`. A secret key there is refused, and so is any field named like a key. Without a `reference_price_usd`, the first live run only records the price.

If you sign the transaction, you are swapping real funds at a price that has moved since the quote. A quote is not a fill. Simulate again right before you sign.

## Signing is yours

`out/unsigned-1.json` holds `transaction_base64`, the fee payer, the blockhash and the block height it is valid until, plus the simulation and the pre-flight result. To act on it, load the transaction in a wallet or a signing tool you control, look at what it does, and sign it only if you mean to swap. This template ships no code that signs or sends, and a test checks `src/` for it. If you add a signer yourself, keep the kit's rule: simulate first, and never give the process more than you are willing to have it spend.

## Venue and fee

Sato Route is the labelled default. Its fee is disclosed on every quote and printed verbatim, and a Jupiter quote with no Sato fee is shown alongside so you can compare. To skip Sato entirely, set `"venue": "direct"` in `config.json`; the kit then asks Jupiter only and makes no call to Sato Hub.

## policy.json

A `sato.policy/v1` file:

| Field | Value |
|---|---|
| `network` | `fork` (the default; fixture mode). `mainnet` is needed for `live`. |
| `allow_chains` | `solana` |
| `allow_tokens` | SOL (the wrapped SOL mint), as `solana:<mint>` |
| `max_usd_per_trade` | 15 |
| `max_usd_per_day` | 20 |
| `max_per_trade` | 500000000 lamports (0.5 SOL) |
| `max_slippage_bps` | 100 |
| `unknown_verdict` | `refuse`: a value the kit cannot read refuses; it never reads as fine |
| `intent_ttl_s` | 120 |

These are starter caps. Raising one is your decision, not a fix for a refusal. A refusal names its rule id, the limit and the value observed. The kit's pre-flight explains every refusal; enforcement lives in the signer, and this agent has none, so the file decides whether a swap is prepared at all and your wallet decides whether it is sent.

### The daily cap

The kit counts USD from executed receipts, and this agent never executes. So `max_usd_per_day` here counts what the agent has **prepared** today: every swap that cleared the pre-flight, whether or not you went on to sign it. That is the cautious reading. In `live` mode the total is kept in `.sato/ledger.json` (gitignored) so it survives a restart and resets at 00:00 UTC. A ledger file that cannot be read makes the total unknown, and an unknown total refuses.

The USD value of a swap is Jupiter's own `swapUsdValue` when it supplies one, else the USDC side of the quote counted as 1 USD. A swap whose value cannot be found is refused.

## Preflight: what do my dependencies do with keys?

```sh
npm run preflight
```

For each dependency that handles keys, it:

1. reads the exact tarball URL and integrity hash from `package-lock.json`, downloads that tarball from the npm registry, checks the bytes against the lockfile's integrity and takes their **sha256**;
2. reads that build's **Sato Check receipt**;
3. prints what the receipt says and whether it is the same build.

Which dependencies: every direct dependency, plus the packages on the `watch` list in `receipts.config.json` (the kit, `@solana/*` key and transaction packages, viem, the `@noble` and `@scure` crypto libraries). `--all` checks the whole production tree; `--only a,b` checks the ones you name.

### What a receipt is

A receipt is a dated Sato Check reading of one exact build of an npm package (the sha256 of its tarball), recorded as a [Solana Attestation Service](https://github.com/solana-foundation/solana-attestation-service) attestation under a Sato Hub credential. It says what Sato Check found the package does with keys: whether it takes a key, whether a planted test key left the machine, how many actions can move funds. It describes. It is not a safety rating, an audit or an endorsement.

Anyone can find a receipt without asking Sato Hub. The attestation's address follows from the package and version alone:

```
nonce   = sha256("<subject_id>@<version>")  read as a 32-byte public key      e.g. subject_id = npm:@satohub/kit
address = PDA of program 22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG
          with seeds ["attestation", credential, schema, nonce]
```

`src/preflight/sas.ts` derives that address, reads the schema and attestation accounts with `getMultipleAccounts`, and decodes the data by the schema's own field names and types. It uses `@solana/kit` and no Sato Hub code; `test/sas.test.ts` checks it against account bytes made by the official SAS encoders. No key is involved and no request goes to Sato Hub.

### Where the receipt is read from

`receipts.config.json` names the cluster and the Sato Hub credential and schema addresses. **It ships with `credential` and `receipt_schema` set to `null`** until Sato Hub publishes them. While they are `null`, the preflight cannot read the chain, so it asks the Sato Hub API for the same receipt (`GET <api_url>?id=<subject_id>&version=<version>`) and says so in its first lines. If a chain read fails, it falls back to the API for those packages the same way. The API is one call to a Sato Hub server, so it is the weaker source; the output always says which source answered. `--source chain` and `--source api` force one.

The Solana RPC is `rpc_url` in the config, or `SATO_RECEIPTS_RPC_URL`, or the cluster's public endpoint.

### Reading the output

Example, with mocked data (a mocked chain, a mocked registry; the "reading" is a test fixture, not a real receipt):

```
Sato Check receipts for the packages this agent installs
Read from Solana devnet (SAS program 22zo…4BdG) with no key and no call to Sato Hub, through api.devnet.solana.com.

Package             Reading     Key access         Key leaves?   This build
------------------  ----------  -----------------  ------------  -----------------------------
@satohub/kit@0.1.1  2026-10-05  no key read found  not observed  ✓ same build as recorded
@solana/kit@8.4.0   —           —                  —             — no reading for this version
viem@2.57.2         —           —                  —             — no reading for this version

3 checked · 1 same build as recorded · 0 different build · 2 no reading
```

| This build | Means |
|---|---|
| `✓ same build as recorded` | the sha256 of the tarball you installed equals the digest in the receipt |
| `⚠ different build` | a receipt exists for this name and version, but for other bytes. It lists both digests. |
| `— no reading for this version` | Sato Check holds no record for this version. It does not mean anything is wrong. |
| `⚠ tarball differs from package-lock.json` | the registry served bytes that do not match your lockfile's integrity hash; no receipt is compared |
| `? could not check` | the tarball or every receipt source was unreachable; the reason is listed |

"Not observed" under *Key leaves?* means no planted test key left the machine during install and start-up under Sato Check's test conditions; code paths that only run later are not covered.

### Options and exit codes

`npm run preflight -- --help` lists them. The command exits **0 unless you pass `--strict`**, so it never breaks an install by default. `--strict` exits 1 when a build differs from its receipt, a tarball differs from the lockfile, or Sato Check observed a key leave; add `--require-reading` to also fail on "no reading" and "could not check". Exit 2 means the check could not run (bad options or files). `out/preflight.json` has the full result; `--json` prints it.

## What it does NOT do

- **It never signs and never sends.** There is no signer in any mode, no `--execute`, and no code path to `sendTransaction`. The kit's `execute` is not called.
- **It does not hold a key.** `config.json` takes a public address only; a secret key there is refused.
- **The quote is not a fill.** Prices move between a quote and any trade, and the unsigned transaction expires.
- **A simulation is not a guarantee.** It says the transaction ran at one slot against the state the RPC saw, not what will happen when you sign.
- **A receipt does not rate a package.** It describes one build on one date. A missing receipt means no record, not a problem.
- **It is not advice.** Nothing here says a swap is a good idea.

## Refreshing the recordings

`fixtures/` holds answers recorded on Solana mainnet-beta for a fixed public wallet (`src/runtime.ts`, `FIXTURE_WALLET`; nobody here holds its key). To record again, set `"network": "mainnet"` in `policy.json` and run:

```sh
SOLANA_RPC_URL=https://your-rpc.example npm start -- --mode live --accept-mainnet-risk --record
```

It writes every RPC answer into `fixtures/rpc.json` and every venue request and response into `fixtures/http/`. The venue calls are live and send the user agent `sato-template/solana-guarded-swapper@0.1.0`. In fixture mode an unrecorded request throws; it never reaches the network. Remove answers the run did not use before you commit.

## Checks

Every pull request and every night: install, typecheck, the fixture run, the tests and a dependency custody check. The tests include `npm run preflight` against a mocked Solana RPC, a mocked receipts API and mocked tarballs. A green check means the code ran on that date. It is not a security review of Jupiter, Solana or this code.

## Before you sign

A swap is a real onchain action with real costs. Signing the prepared transaction trades your SOL at the price the venue gives you when it lands, and you pay the network fee. A simulation that succeeds means the call did not fail at the simulated slot. Nothing here is investment advice. Check the transaction, simulate again right before you sign, and sign only if you mean to swap.

Licensed MIT. See `LICENSE-ATTRIBUTION.md`.
