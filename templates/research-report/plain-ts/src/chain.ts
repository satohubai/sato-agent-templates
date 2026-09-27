// Onchain reads, through the Sato Kit's chain.read, turned into corpus sources.
//
// Each `chain_reads` entry in the input becomes ONE source whose text is a
// sentence carrying the exact value read and the block it was read at. The
// gate then treats it like any supplied source: a finding may cite it, and
// every number in that finding must appear in its sentence. A read that fails
// is not a source; it is an unknown with the reason.

import type { Kit } from "@satohub/kit";
import { ACTIONS, TOTAL_SUPPLY_FRAGMENT, type ChainName, type ChainReadInput, type ChainReadOutput } from "./kit-io.js";
import type { Source, UnknownItem } from "./verify.js";

export type ChainReadRequest = {
  id: string;
  chain: ChainName;
  kind: "block_number" | "native_balance" | "erc20_balance" | "erc20_total_supply";
  address?: string;
  token?: string;
  owner?: string;
  label?: string;
};

export type ChainReadRecord = { id: string; kind: ChainReadRequest["kind"]; chain: string; ok: boolean; block_number: string | null; detail: string };

function kitInput(r: ChainReadRequest): ChainReadInput {
  switch (r.kind) {
    case "block_number":
      return { kind: "block_number", chain: r.chain };
    case "native_balance":
      return { kind: "native_balance", chain: r.chain, address: r.address ?? "" };
    case "erc20_balance":
      return { kind: "erc20_balance", chain: r.chain, token: r.token ?? "", owner: r.owner ?? "" };
    case "erc20_total_supply":
      return { kind: "contract_read", chain: r.chain, contract: r.token ?? "", abi: TOTAL_SUPPLY_FRAGMENT };
  }
}

function sentence(r: ChainReadRequest, out: ChainReadOutput<string>): string {
  const at = `On ${out.chain} at block ${out.block_number}`;
  const body =
    r.kind === "block_number"
      ? `${at}, the chain's latest block number was ${String(out.result)}.`
      : r.kind === "native_balance"
        ? `${at}, the native balance of ${r.address} was ${String(out.result)} wei.`
        : r.kind === "erc20_balance"
          ? `${at}, balanceOf(${r.owner}) on token ${r.token} returned ${String(out.result)} base units.`
          : `${at}, totalSupply() on token ${r.token} returned ${String(out.result)} base units.`;
  return r.label ? `${r.label}. ${body}` : body;
}

export async function resolveChainReads(kit: Kit, reads: readonly ChainReadRequest[], chains: readonly ChainName[]): Promise<{ sources: Source[]; unknowns: UnknownItem[]; records: ChainReadRecord[] }> {
  const sources: Source[] = [];
  const unknowns: UnknownItem[] = [];
  const records: ChainReadRecord[] = [];
  for (const r of reads) {
    if (!chains.includes(r.chain)) {
      const detail = `this run reads ${chains.join(", ")} only`;
      records.push({ id: r.id, kind: r.kind, chain: r.chain, ok: false, block_number: null, detail });
      unknowns.push({ question: `chain read ${r.id} (${r.kind} on ${r.chain})`, reason: detail });
      continue;
    }
    try {
      const out = await kit.read<ChainReadOutput<string>>(ACTIONS.chainRead, kitInput(r));
      const content = sentence(r, out);
      sources.push({ id: r.id, kind: "chain-read", url: `chain:${out.chain}/block/${out.block_number}`, retrieved_at: out.as_of, content });
      records.push({ id: r.id, kind: r.kind, chain: out.chain, ok: true, block_number: out.block_number, detail: content });
    } catch (e) {
      const detail = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      records.push({ id: r.id, kind: r.kind, chain: r.chain, ok: false, block_number: null, detail });
      unknowns.push({ question: `chain read ${r.id} (${r.kind} on ${r.chain})`, reason: detail });
    }
  }
  return { sources, unknowns, records };
}
