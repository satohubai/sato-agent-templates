// Telegram, over the official Bot API with fetch (https://core.telegram.org/bots/api).
//   getUpdates  GET  https://api.telegram.org/bot<token>/getUpdates?offset=<n>&timeout=<s>
//   sendMessage POST https://api.telegram.org/bot<token>/sendMessage  { chat_id, text }
// Off unless TELEGRAM_BOT_TOKEN is set. The token is never logged.

import type { Connector, Fetch, Inbound } from "./types.js";

export const TELEGRAM_API = "https://api.telegram.org";

type Update = { update_id: number; message?: { chat: { id: number | string }; from?: { username?: string; id: number }; text?: string } };

export class TelegramConnector implements Connector {
  readonly name = "telegram";
  private offset = 0;
  constructor(private readonly token: string, private readonly f: Fetch = fetch, private readonly timeoutS = 0) {}

  private url(method: string): string {
    return `${TELEGRAM_API}/bot${this.token}/${method}`;
  }

  async poll(): Promise<Inbound[]> {
    const res = await this.f(`${this.url("getUpdates")}?offset=${this.offset}&timeout=${this.timeoutS}&allowed_updates=${encodeURIComponent('["message"]')}`, { signal: AbortSignal.timeout((this.timeoutS + 15) * 1000) });
    const body = (await res.json()) as { ok: boolean; result?: Update[]; description?: string };
    if (!body.ok) throw new Error(`telegram getUpdates: ${body.description ?? res.status}`);
    const out: Inbound[] = [];
    for (const u of body.result ?? []) {
      this.offset = Math.max(this.offset, u.update_id + 1);
      if (u.message?.text) out.push({ connector: this.name, chat_id: String(u.message.chat.id), user: u.message.from?.username ?? String(u.message.from?.id ?? "unknown"), text: u.message.text });
    }
    return out;
  }

  async send(chatId: string, text: string): Promise<void> {
    const res = await this.f(this.url("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as { ok: boolean; description?: string };
    if (!body.ok) throw new Error(`telegram sendMessage: ${body.description ?? res.status}`);
  }
}
