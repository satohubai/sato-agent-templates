// Discord, over the official REST API v10 with fetch (https://discord.com/developers/docs/resources/message).
//   list   GET  https://discord.com/api/v10/channels/<id>/messages?after=<snowflake>&limit=50
//   create POST https://discord.com/api/v10/channels/<id>/messages  { content }
// Header: Authorization: Bot <token>. Polls the channels named in
// DISCORD_CHANNEL_IDS; reading message text needs the bot's Message Content
// intent enabled in the Discord developer portal. Off unless DISCORD_BOT_TOKEN
// is set. The token is never logged. This is a thin polling adapter, not a
// Gateway client.

import type { Connector, Fetch, Inbound } from "./types.js";

export const DISCORD_API = "https://discord.com/api/v10";

type Message = { id: string; content: string; author: { id: string; username: string; bot?: boolean } };

export class DiscordConnector implements Connector {
  readonly name = "discord";
  private after = new Map<string, string>();
  constructor(private readonly token: string, private readonly channels: string[], private readonly f: Fetch = fetch) {}

  private headers(): Record<string, string> {
    return { authorization: `Bot ${this.token}`, "content-type": "application/json", "user-agent": "DiscordBot (https://github.com/satohubai/sato-agent-templates, 0.1.0)" };
  }

  async poll(): Promise<Inbound[]> {
    const out: Inbound[] = [];
    for (const ch of this.channels) {
      const after = this.after.get(ch);
      const q = after ? `?after=${after}&limit=50` : "?limit=1";
      const res = await this.f(`${DISCORD_API}/channels/${ch}/messages${q}`, { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`discord list messages ${ch}: HTTP ${res.status}`);
      const msgs = ((await res.json()) as Message[]).slice().sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      for (const m of msgs) this.after.set(ch, m.id);
      // The first poll only sets the cursor, so old history is not answered.
      if (!after) continue;
      for (const m of msgs) if (!m.author.bot && m.content) out.push({ connector: this.name, chat_id: ch, user: m.author.username, text: m.content });
    }
    return out;
  }

  async send(chatId: string, text: string): Promise<void> {
    const res = await this.f(`${DISCORD_API}/channels/${chatId}/messages`, { method: "POST", headers: this.headers(), body: JSON.stringify({ content: text.slice(0, 2000) }), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`discord create message ${chatId}: HTTP ${res.status}`);
  }
}
