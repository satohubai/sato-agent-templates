# token-launch-prep (plain TypeScript)

Prepares a [Clanker v4](https://clanker.gitbook.io/documentation/sdk-reference/v4) token deploy on Base as an **unsigned transaction**, decodes it into a readable summary, and simulates it before you decide anything. You sign it in your own wallet if you choose to launch. This repository holds no key, signs nothing and sends nothing, in every mode.

## What it does

1. Reads `config.json` (shape: `schemas/input.json`): token name, symbol, your address as `creator`, and optional image, description, pool preset and fees.
2. Builds the Clanker v4 `deployToken` call with viem's encoders: the factory address, calldata, `value` 0 and the chain id.
3. Decodes that calldata back and writes the summary from the decoded bytes, so what you read is what you would sign.
4. Simulates it through the Sato Kit's `tx.simulate` (`eth_call` + `eth_estimateGas`, no signer): passes or reverts, gas estimate, the block, and the token address the factory returned in the simulation.
5. Writes `out/report.json` (shape: `schemas/output.json`) and prints the summary.

The output has `signed: false` and `broadcast: false`, always. There is no code path that signs or sends: the kit is built with no signer and with one action, `tx.simulate`, and the tests check that no signing or sending call exists in `src/` or `scripts/`.

## Who gets the rewards

The `creator` address is the token admin and the **only** reward recipient (and that recipient's admin), with all 10000 bps of the reward split. No other address is written: not the template's, not Sato Hub's, not a referrer's. The split is checked to total exactly 10000 bps before it is encoded, and checked again on the decoded calldata. Any share Clanker's own contracts keep is set by Clanker, not by this template; read Clanker's documentation for the current figures.

## Run it

```sh
npm ci
npm run typecheck
npm test
npm start -- --mode fixture
```

| Mode | What it uses | Network |
|---|---|---|
| `--mode fixture` (default) | `config.json` and `fixtures/scenarios/*`, answered from `fixtures/rpc.json` (recorded on a Base fork at block 51800000) | none |
| `--mode fork` | a local anvil fork of Base at `ANVIL_RPC_URL` | your machine |
| `--mode rpc --rpc <url>` | a Base or Base Sepolia RPC you choose (or `SATO_RPC_URL_BASE`); read-only calls only | the RPC you name |

A fork for `--mode fork`:

```sh
anvil --fork-url https://mainnet.base.org --fork-block-number 51800000 --port 8547
ANVIL_RPC_URL=http://127.0.0.1:8547 npm start -- --mode fork
```

To simulate against the current chain instead of the pinned block, fork without `--fork-block-number`, or use `--mode rpc`. For Base Sepolia, set `"chain": "base-sepolia"` in `config.json` and pass a Base Sepolia RPC with `--mode rpc`.

Exit codes: 0 when every simulation passed, 3 when one did not (the report is still written; do not sign that transaction), 2 for a usage or input error, 1 for anything else.

## Input

| Field | Default | Notes |
|---|---|---|
| `name` | required | 1-64 characters |
| `symbol` | required | 1-16 of `A-Z a-z 0-9 $ . _ -` |
| `creator` | required | your address: token admin and the only reward recipient |
| `sender` | `creator` | the address that will sign; the simulation runs as this sender |
| `chain` | `base` | `base` or `base-sepolia`; the RPC must answer this chain |
| `image` | empty | `https://` or `ipfs://` URL |
| `description` | none | stored in the token's metadata |
| `interface_name` | `token-launch-prep` | the `interface` in the token's context string |
| `salt` | 32 zero bytes | CREATE2 salt, as in clanker-sdk |
| `pool_preset` | `standard` | `standard` (one position) or `project` (five), ticks from clanker-sdk |
| `fees` | 100 / 100 bps | static fee on the token side and the WETH side, each at most 2000 bps |
| `reward_token` | `Both` | which side of the fees the creator's position takes: `Both`, `Paired` or `Clanker` |

There is no key field. A property whose name looks like one (`private_key`, `mnemonic`, `seed`, `secret`, `signer`, ...) is refused with an explanation. `config.json` ships with an example creator, `0x...dEaD`, that nobody can sign for; the summary says so until you replace it.

Not offered here: dev buy, vault, airdrop and presale extensions, dynamic fees, a paired token other than WETH, and extra reward recipients. `value` is always 0, so the deploy moves no ETH beyond the gas you pay.

## Where the addresses come from

The factory, locker, hook, MEV module and fee locker addresses, the ABI fragments and the defaults (pool ticks, 1% static fee, sniper fee schedule) are copied from [clanker-sdk](https://github.com/clanker-devco/clanker-sdk) 4.2.19 and cross-checked against Clanker's [deployed contracts page](https://clanker.gitbook.io/clanker-documentation/references/deployed-contracts). The template does not depend on the SDK because the SDK includes a function that signs and sends the deploy; this template has no such path. `test/clanker.test.ts` pins the copied values, and the nightly fork check confirms there is contract code at each address and that the deploy simulates at the pinned block.

## Base Sepolia

clanker-sdk 4.2.19 lists a Clanker v4 deployment on Base Sepolia (chain id 84532) at the same factory address as Base, with its own locker, hook and MEV module; Clanker's docs list chain id 84532 as supported and publish the Base Sepolia v4.1 hook addresses. The weekly testnet check confirms the contract code and simulates a deploy there with no key.

## Checks

- Every pull request and every night: install, typecheck, fixture run, tests, and a fork check against an anvil fork of Base at block 51800000 (`npm run fork-check`).
- Weekly: `npm run testnet-check` against a public Base Sepolia RPC, keyless.

A passing check means the code ran and the deploy simulated on that date. It is not a security review of Clanker's contracts or of this code.

## Before you sign

Launching a token is a real onchain action with real costs. Signing the prepared transaction creates a token contract and a Uniswap v4 pool that anyone can trade, and you pay the gas. A passing simulation means the call did not revert at the simulated block; it is not a security review, an audit, a price forecast or a statement about what the token will do after it launches. Nothing here is investment advice. Check every address in the summary against the sources above, simulate again right before you sign, and sign only if you mean to launch.

Licensed MIT. See `LICENSE-ATTRIBUTION.md`.
