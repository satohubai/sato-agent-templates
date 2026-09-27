// Balances through the Sato Kit's chain.read, and nothing else.
//
// Every read is a kit action (`native_balance` or `erc20_balance`), so the same
// code runs in fixture mode (recorded RPC answers), on a fork and against an
// RPC you name. chain.read is read-only by construction: it can never send a
// state-changing call. A chain this run has no RPC for is reported unknown,
// never zero.

import type { Kit } from "@satohub/kit";
import { ACTIONS, CHAIN_BY_ID, type ChainName, type ChainReadInput, type ChainReadOutput } from "./kit-io.js";
import type { Asset, BalanceRead, BalanceSource } from "./task.js";

export function kitSource(kind: BalanceSource["kind"], kit: Kit, chains: readonly ChainName[]): BalanceSource {
  return {
    kind,
    async balanceOf(chainId: number, address: string, asset: Asset): Promise<BalanceRead> {
      const chain = CHAIN_BY_ID[chainId];
      if (!chain || !chains.includes(chain)) return { ok: false, reason: `this run reads ${chains.join(", ")} only` };
      const input: ChainReadInput =
        asset.token === null || asset.token === undefined
          ? { kind: "native_balance", chain, address }
          : { kind: "erc20_balance", chain, token: asset.token, owner: address };
      try {
        const out = await kit.read<ChainReadOutput<string>>(ACTIONS.chainRead, input);
        return { ok: true, base_units: String(out.result), chain: out.chain, block_number: out.block_number };
      } catch (e) {
        return { ok: false, reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
      }
    },
  };
}
