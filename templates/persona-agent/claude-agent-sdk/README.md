# persona-agent (Claude Agent SDK)

A character with a memory that answers on Telegram and Discord, with a wallet through the Sato Kit. It covers what builders use ElizaOS for, with no ElizaOS dependency: the loop is the Claude Agent SDK, and every wallet action goes through the kit's prepare -> pre-flight path.

```
npm ci
npm start -- --mode fixture
```

Fixture mode replays `fixtures/inbound/messages.json` through fake Telegram and Discord connectors and a scripted model. It needs no network, no token and no key. It prints each reply and one over-cap wallet intent the pre-flight refused, with its rule, limit and observed value, and writes `out/report.json`.

## Pieces

| File | What it is |
| --- | --- |
| `character.json` | Name, bio, style rules, topics and example replies. Becomes the system prompt. |
| `src/memory.ts` | A local JSONL store (`data/memory.jsonl` in live modes), append-only, with word-overlap retrieval per chat. No embeddings, no network. |
| `src/connectors/telegram.ts` | Telegram Bot API over fetch: `getUpdates` and `sendMessage`. On only when `TELEGRAM_BOT_TOKEN` is set. |
| `src/connectors/discord.ts` | Discord REST API v10 over fetch: list and create channel messages, polling the channels in `DISCORD_CHANNEL_IDS`. On only when `DISCORD_BOT_TOKEN` is set. Needs the bot's Message Content intent. A polling adapter, not a Gateway client. |
| `src/wallet.ts` | Quote (`swap.quote`) and prepare (`swap.prepare`) through the Sato Kit. |
| `src/claude.ts` | Live model: Claude Agent SDK `query()`, default model `claude-opus-5-5`, built-in tools off, two in-process tools: `wallet_quote` and `wallet_prepare`. |
| `policy.json` | `sato.policy/v1`: caps, allowed tokens, `unknown_verdict: refuse`, `human_approval: true`. |

## Live modes

```
ANTHROPIC_API_KEY=... TELEGRAM_BOT_TOKEN=... ANVIL_RPC_URL=http://127.0.0.1:8545 npm start -- --mode fork
```

- `--mode fork`: the wallet runs on a local anvil fork of Base with a throwaway in-memory key, wrapped so it cannot broadcast.
- `--mode testnet`: Base Sepolia with a Coinbase CDP managed wallet (`BASE_SEPOLIA_RPC_URL`, `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET`, and `npm install @coinbase/cdp-sdk`). Nothing is signed unless you pass `--allow-execute`, and even then the kit's `humanApprove` signer asks you at the terminal before every signature; anything but `yes` refuses.
- `--once` polls each connector once and exits.

Set at least one connector token. Both are optional; a connector without its token stays off.

The kit's pre-flight explains every refusal. Enforcement lives in the signer: this process can edit `policy.json`, so on testnet the managed wallet's own policy is the control.

## What it does NOT do

- It does not run on mainnet. There is no mainnet mode.
- The model cannot sign or send. It has no execute tool; execution happens only on testnet, with `--allow-execute`, after a person types `yes`.
- Fixture and fork runs never execute.
- It does not tell anyone what to buy or sell, and makes no claim that it makes money.
- It does not store a private key on disk. Fork keys live in memory; testnet uses a managed wallet.
- It does not read Discord through the Gateway, handle voice, images or DMs, or run as a hosted service.
- It does not depend on ElizaOS or load ElizaOS plugins.

Requests carry the user-agent `sato-template/persona-agent@0.1.0`.
