// A small local memory: one JSON object per line in a file (JSONL), appended,
// never rewritten. Retrieval is deterministic word overlap within the same
// chat, newest first on a tie. No embeddings and no network.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type MemoryEntry = {
  at: string;
  connector: string;
  chat_id: string;
  user: string;
  role: "user" | "agent";
  text: string;
};

const STOP = new Set(["the", "a", "an", "and", "or", "to", "of", "is", "it", "my", "me", "you", "i", "what", "do", "about", "please", "for", "on", "in", "right", "now"]);

export function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)));
}

export class MemoryStore {
  constructor(readonly path: string) {}

  all(): MemoryEntry[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as MemoryEntry);
  }

  append(e: MemoryEntry): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(e) + "\n");
  }

  /** Up to k entries from the same chat that share words with `query`, highest overlap first. */
  retrieve(chatId: string, query: string, k: number): MemoryEntry[] {
    const q = words(query);
    return this.all()
      .map((e, i) => ({ e, i, score: e.chat_id === chatId ? [...words(e.text)].filter((w) => q.has(w)).length : 0 }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.i - a.i)
      .slice(0, k)
      .map((x) => x.e);
  }

  /** The newest k entries in a chat. */
  recent(chatId: string, k: number): MemoryEntry[] {
    return this.all().filter((e) => e.chat_id === chatId).slice(-k);
  }
}
