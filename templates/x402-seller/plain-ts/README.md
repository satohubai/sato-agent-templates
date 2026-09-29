# x402-seller (plain TypeScript)

A small HTTP API behind [x402](https://docs.x402.org) v2. Each paid route:

1. answers an unpaid request with **402** and its offer in the `PAYMENT-REQUIRED` header (base64 JSON: `x402Version: 2`, `resource`, `accepts[]` with scheme `exact`, network, asset, amount, payTo, and a Bazaar discovery extension);
2. checks a presented payment (`PAYMENT-SIGNATURE`, or the older `X-PAYMENT`) against its own offer first — price, asset, payee, network, time window — and refuses a mismatch with a named reason, without calling anyone;
3. asks a **facilitator** to verify the buyer's signed ERC-3009 authorization;
4. runs the API; a non-200 answer is returned **without settling** (an error is never charged);
5. asks the facilitator to settle, then **confirms the settlement through the Sato Kit's `chain.read`** (the token's `authorizationState(payer, nonce)` must now be `true`) and answers **200** with `PAYMENT-RESPONSE` and a settlement receipt.

It also writes `out/listing.json`, a discovery listing for your paid routes. **You** submit it; the template never publishes anything.

The seller holds no key in any mode. It only receives.

## Run it

```sh
npm ci
npm start -- --mode fixture     # default: no network, no key
npm test
```

| Mode | Facilitator | Chain reads | Network |
|---|---|---|---|
| `fixture` (default) | `FakeFacilitator`: checks the EIP-712 signature and the nonce locally and returns a labelled fixture hash; moves nothing | recorded answers in `fixtures/rpc.json` | none |
| `fork` | `ForkFacilitator`: checks signature, balance and nonce, then submits `transferWithAuthorization` from anvil's unlocked dev account on your **local** fork | `ANVIL_RPC_URL` | your machine only |
| `testnet` | the HTTP facilitator in `config.json` (`https://x402.org/facilitator`, POST `/verify` and `/settle`) | `SATO_RPC_URL_BASE_SEPOLIA`, default `https://sepolia.base.org` | Base Sepolia |

There is no mainnet mode. `--mode mainnet` is refused.

### Fixture run

`npm start -- --mode fixture` replays `fixtures/scenarios/*.json` in order through the same payment gate the server uses, and writes `out/report.json`:

| Scenario | Result |
|---|---|
| `01-unpaid` | 402 with the offer |
| `02-paid` | 200, `PAYMENT-RESPONSE`, a receipt whose settlement `chain.read` confirms |
| `03-replay` | 402 `nonce_already_used` |
| `04-over-price` | 402 `amount_exceeds_price` (refused before the facilitator) |
| `05-wrong-asset` | 402 `asset_not_accepted` (refused before the facilitator) |
| `06-bad-signature` | 402 `invalid_signature` |

The fixture payments in `fixtures/payments/` were signed once with a throwaway test key that was never stored. The recorded chain reads come from a local anvil fork where that exact payment was settled (`npm run fork-check -- --record`).

### Fork run

```sh
anvil --fork-url https://mainnet.base.org --fork-block-number 51800000 --port 8547
ANVIL_RPC_URL=http://127.0.0.1:8547 npm run fork-check      # funds the fixture payer on the fork, settles, confirms, replays
ANVIL_RPC_URL=http://127.0.0.1:8547 npm start -- --mode fork  # serves on :4021
```

### Testnet run (Base Sepolia)

1. Set `service.pay_to` in `config.json` to an address you control. The placeholder burn address is refused in testnet mode.
2. `npm start -- --mode testnet` and call `GET http://localhost:4021/api/item?id=x402-v2` from any x402 v2 client with Base Sepolia test USDC (asset `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, network `eip155:84532`).
3. Receipts are appended to `out/receipts.jsonl`.

The public facilitator at `https://x402.org/facilitator` settles Base Sepolia payments and needs no account. Check its current supported networks before relying on it.

## Configure

`config.json` (schema: `schemas/input.json`):

- `service`: `name` (≤32 characters), `public_url` (the base URL buyers call; it becomes each `resource.url`), `tags` (≤5), `pay_to`.
- `networks.fork` / `networks.testnet`: chain, CAIP-2 network id, asset address, the asset's EIP-712 `name`/`version` (USDC is `USD Coin`/`2` on Base, `USDC`/`2` on Base Sepolia), and the facilitator.
- `routes[]`: `method` (GET), `path`, **`price_base_units`** (the exact price in token base units; USDC has 6 decimals, so `1000` is 0.001 USDC), `description` (≤500 characters), `mime_type`, and the query/output examples the discovery extension carries.

Replace `src/api.ts` with your own handler. The payment gate (`src/server.ts`) only needs it to return a status and a body.

## Getting listed

`out/listing.json` (written on every run) holds, per paid route, the `resource` object (url, description, mimeType, serviceName, tags), the `accepts[]` offer and the Bazaar discovery extension (`info.input` with `type: "http"`, `method`, `queryParams`; `info.output`; and its JSON Schema). The same extension travels in every 402, so a facilitator that catalogues resources can read it from the payment the buyer echoes back.

The template submits nothing. To list your API:

1. Deploy it at the `public_url` you configured.
2. Validate the live route with the catalogue you target. Coinbase's CDP facilitator offers a validator, `POST https://api.cdp.coinbase.com/platform/v2/x402/validate` with `{"resource": "<your url>", "method": "GET"}`.
3. The Bazaar indexes a route when a facilitator that runs it processes a payment carrying the `bazaar` extension. Settle through such a facilitator yourself.
4. Other catalogues take a submission form or a discovery document. Submit `listing.json`'s fields there.

Which catalogues exist, what they accept and when they index changes; read their current docs before you submit.

## What it does NOT do

- It holds no key and signs nothing. `pay_to` is a public address; the facilitator pays the gas and submits the buyer's authorization.
- It does not run on mainnet, and it never moves funds outside a local fork or Base Sepolia.
- It does not publish, submit or register the listing anywhere.
- The fake facilitator does not read balances and does not move anything; its transaction hash is a labelled stand-in.
- It does not refund. A payment that settles but is not confirmed on-chain is reported as `unconfirmed` in the receipt, never as confirmed.
- It supports the `exact` scheme with ERC-3009 tokens and EOA buyer signatures only; smart-wallet (ERC-1271/6492) buyers are verified by a real facilitator, not by the fixture or fork facilitator.
- It is not audited and makes no claim about the buyer, the facilitator or the asset.

## Files

| Path | What it is |
|---|---|
| `src/x402.ts` | the v2 wire format and the seller's own checks |
| `src/server.ts` | the payment gate as one function, and the HTTP server |
| `src/facilitator.ts` | fake, fork and HTTP facilitators |
| `src/confirm.ts` | settlement confirmation through `chain.read` |
| `src/listing.ts` | the discovery listing file |
| `src/kit-io.ts` | the one place kit action ids and shapes are named |
| `policy.json` | a `sato.policy/v1` file with a refusing default (`unknown_verdict: refuse`) |
| `vendor/` | the vendored `@satohub/kit` preview build |
