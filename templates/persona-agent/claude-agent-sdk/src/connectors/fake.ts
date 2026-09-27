// Fixture mode: a connector that replays scripted inbound messages and keeps
// every reply in memory. No network, no token.

import type { Connector, Inbound } from "./types.js";

export class FakeConnector implements Connector {
  readonly sent: { chat_id: string; text: string }[] = [];
  private queue: Inbound[];
  constructor(readonly name: string, inbound: Inbound[]) {
    this.queue = inbound.filter((m) => m.connector === name);
  }
  async poll(): Promise<Inbound[]> {
    const next = this.queue.shift();
    return next ? [next] : [];
  }
  async send(chatId: string, text: string): Promise<void> {
    this.sent.push({ chat_id: chatId, text });
  }
}
