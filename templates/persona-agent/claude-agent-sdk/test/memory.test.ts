import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/memory.js";

const e = (chat: string, text: string, at: string) => ({ at, connector: "telegram", chat_id: chat, user: "u", role: "user" as const, text });

test("append then retrieve by word overlap, same chat only, highest overlap first", () => {
  const m = new MemoryStore(join(mkdtempSync(join(tmpdir(), "mem-")), "m.jsonl"));
  assert.deepEqual(m.all(), []);
  m.append(e("a", "my agent watches treasury balances", "2026-09-01T00:00:00Z"));
  m.append(e("a", "I like tea", "2026-09-02T00:00:00Z"));
  m.append(e("b", "agent treasury balances elsewhere", "2026-09-03T00:00:00Z"));
  m.append(e("a", "treasury agent alerts balances watches", "2026-09-04T00:00:00Z"));
  const got = m.retrieve("a", "what does my agent watch in the treasury balances?", 5);
  assert.deepEqual(got.map((x) => x.at), ["2026-09-04T00:00:00Z", "2026-09-01T00:00:00Z"]);
  assert.equal(m.retrieve("a", "zzz", 5).length, 0);
  assert.equal(m.recent("a", 1)[0].text, "treasury agent alerts balances watches");
});
