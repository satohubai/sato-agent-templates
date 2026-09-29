// The small API that sits behind x402. Replace this handler with your own; the
// payment gate in src/server.ts does not care what it returns, only that it
// answers 200 before a payment is settled (an error is never charged).

import { readFileSync } from "node:fs";

type Item = { id: string; title: string; summary: string };
const DATA = JSON.parse(readFileSync(new URL("../data/items.json", import.meta.url), "utf8")) as { items: Record<string, Item> };

export type ApiResult = { status: number; body: unknown };

export function handleApi(path: string, query: Record<string, string>): ApiResult {
  if (path === "/api/item") {
    const id = query.id;
    if (!id) return { status: 400, body: { error: "missing_id", message: "pass ?id=<item id>" } };
    const item = DATA.items[id];
    if (!item) return { status: 404, body: { error: "not_found", message: `no item ${id}`, known: Object.keys(DATA.items) } };
    return { status: 200, body: item };
  }
  return { status: 404, body: { error: "not_found" } };
}
