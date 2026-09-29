#!/usr/bin/env node
// Picks the public Base Sepolia RPC the weekly testnet lane reads from: the
// first candidate that answers eth_chainId with 84532 (0x14a34) wins. No key
// is involved; every candidate is a public endpoint.
//
//   node scripts/testnet-rpc.mjs [url ...]
//     prints the chosen URL on stdout (one line), the attempts on stderr;
//     exits 1 when no candidate answers as Base Sepolia.

import { pathToFileURL } from "node:url";

export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const DEFAULT_CANDIDATES = ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"];
export const USER_AGENT = "SatoHub-templates-ci/1.0";
const TIMEOUT_MS = 10_000;

/** Pure: an eth_chainId JSON-RPC answer → the chain id, or null when it is not one. */
export function chainIdOf(body) {
  const r = body && typeof body === "object" ? body.result : null;
  if (typeof r !== "string" || !/^0x[0-9a-fA-F]+$/.test(r)) return null;
  return Number.parseInt(r, 16);
}

/**
 * The first candidate whose probe answers Base Sepolia's chain id, tried in
 * order. `probe(url)` resolves to the parsed JSON-RPC body or throws.
 * Returns { url: string | null, tried: [{ url, ok, reason }] }.
 */
export async function pickRpc(candidates, probe) {
  const tried = [];
  for (const url of candidates) {
    if (typeof url !== "string" || !/^https:\/\//.test(url)) {
      tried.push({ url: String(url), ok: false, reason: "not an https URL" });
      continue;
    }
    try {
      const id = chainIdOf(await probe(url));
      if (id === BASE_SEPOLIA_CHAIN_ID) {
        tried.push({ url, ok: true, reason: `chain id ${id}` });
        return { url, tried };
      }
      tried.push({ url, ok: false, reason: id === null ? "no chain id in the answer" : `answers chain id ${id}, not ${BASE_SEPOLIA_CHAIN_ID}` });
    } catch (e) {
      tried.push({ url, ok: false, reason: (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200) });
    }
  }
  return { url: null, tried };
}

export async function httpProbe(url) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function main(argv = process.argv.slice(2)) {
  const { url, tried } = await pickRpc(argv.length ? argv : DEFAULT_CANDIDATES, httpProbe);
  for (const t of tried) console.error(`${t.ok ? "ok  " : "skip"} ${t.url} — ${t.reason}`);
  if (!url) {
    console.error("no candidate answered as Base Sepolia");
    process.exit(1);
  }
  console.log(url);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
