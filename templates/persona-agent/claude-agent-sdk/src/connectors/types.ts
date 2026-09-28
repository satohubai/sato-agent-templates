export type Inbound = { connector: string; chat_id: string; user: string; text: string };

export interface Connector {
  readonly name: string;
  /** New messages since the last poll. */
  poll(): Promise<Inbound[]>;
  send(chatId: string, text: string): Promise<void>;
}

export type Fetch = typeof fetch;
