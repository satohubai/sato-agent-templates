import { test } from "node:test";
import assert from "node:assert/strict";
import { liveConnectors } from "../src/connectors/index.js";
import { TelegramConnector } from "../src/connectors/telegram.js";
import { DiscordConnector } from "../src/connectors/discord.js";

type Call = { url: string; init?: RequestInit };
function fakeFetch(answers: unknown[]): { f: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(answers.shift() ?? {}), { status: 200 });
  }) as typeof fetch;
  return { f, calls };
}

test("both connectors are off when no token is set", () => {
  const { connectors, notes } = liveConnectors({});
  assert.equal(connectors.length, 0);
  assert.ok(notes.some((n) => /telegram: off/.test(n)) && notes.some((n) => /discord: off/.test(n)));
});

test("each connector is on only when its token is set", () => {
  assert.deepEqual(liveConnectors({ TELEGRAM_BOT_TOKEN: "t" }).connectors.map((c) => c.name), ["telegram"]);
  assert.deepEqual(liveConnectors({ DISCORD_BOT_TOKEN: "d" }).connectors.map((c) => c.name), []);
  assert.deepEqual(liveConnectors({ DISCORD_BOT_TOKEN: "d", DISCORD_CHANNEL_IDS: "1,2" }).connectors.map((c) => c.name), ["discord"]);
});

test("telegram uses getUpdates with an advancing offset and sendMessage", async () => {
  const { f, calls } = fakeFetch([{ ok: true, result: [{ update_id: 7, message: { chat: { id: 42 }, from: { id: 1, username: "ada" }, text: "gm" } }] }, { ok: true, result: [] }, { ok: true }]);
  const tg = new TelegramConnector("TOKEN", f);
  assert.deepEqual(await tg.poll(), [{ connector: "telegram", chat_id: "42", user: "ada", text: "gm" }]);
  await tg.poll();
  await tg.send("42", "hi");
  assert.match(calls[0].url, /^https:\/\/api\.telegram\.org\/botTOKEN\/getUpdates\?offset=0/);
  assert.match(calls[1].url, /offset=8/);
  assert.equal(calls[2].url, "https://api.telegram.org/botTOKEN/sendMessage");
  assert.deepEqual(JSON.parse(String(calls[2].init?.body)), { chat_id: "42", text: "hi" });
});

test("discord lists channel messages after a cursor, skips bots, and posts content", async () => {
  const { f, calls } = fakeFetch([
    [{ id: "100", content: "old", author: { id: "1", username: "old" } }],
    [
      { id: "102", content: "from a bot", author: { id: "9", username: "b", bot: true } },
      { id: "101", content: "hello", author: { id: "2", username: "lin" } },
    ],
    {},
  ]);
  const dc = new DiscordConnector("TOKEN", ["555"], f);
  assert.deepEqual(await dc.poll(), []);
  assert.deepEqual(await dc.poll(), [{ connector: "discord", chat_id: "555", user: "lin", text: "hello" }]);
  await dc.send("555", "hi");
  assert.equal(calls[0].url, "https://discord.com/api/v10/channels/555/messages?limit=1");
  assert.equal(calls[1].url, "https://discord.com/api/v10/channels/555/messages?after=100&limit=50");
  assert.equal((calls[2].init?.headers as Record<string, string>).authorization, "Bot TOKEN");
  assert.deepEqual(JSON.parse(String(calls[2].init?.body)), { content: "hi" });
});
