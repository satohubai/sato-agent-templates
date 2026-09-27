import { DiscordConnector } from "./discord.js";
import { TelegramConnector } from "./telegram.js";
import type { Connector, Fetch } from "./types.js";

/** Live connectors. Each is on only when its token is set; both are optional. */
export function liveConnectors(env: NodeJS.ProcessEnv, f: Fetch = fetch): { connectors: Connector[]; notes: string[] } {
  const connectors: Connector[] = [];
  const notes: string[] = [];
  if (env.TELEGRAM_BOT_TOKEN) {
    connectors.push(new TelegramConnector(env.TELEGRAM_BOT_TOKEN, f));
    notes.push("telegram: on (TELEGRAM_BOT_TOKEN set)");
  } else notes.push("telegram: off (TELEGRAM_BOT_TOKEN not set)");
  const channels = (env.DISCORD_CHANNEL_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (env.DISCORD_BOT_TOKEN && channels.length) {
    connectors.push(new DiscordConnector(env.DISCORD_BOT_TOKEN, channels, f));
    notes.push(`discord: on (${channels.length} channel(s))`);
  } else if (env.DISCORD_BOT_TOKEN) notes.push("discord: off (DISCORD_BOT_TOKEN set but DISCORD_CHANNEL_IDS is empty)");
  else notes.push("discord: off (DISCORD_BOT_TOKEN not set)");
  return { connectors, notes };
}
