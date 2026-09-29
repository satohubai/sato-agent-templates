// Who verifies and settles a payment. The seller holds no key in any mode; a
// facilitator submits the buyer's signed ERC-3009 authorization and pays gas.
//
//   fixture  FakeFacilitator  — offline. Checks the EIP-712 signature and the
//            nonce locally, then returns a labelled fixture transaction hash.
//            It moves nothing and does not read balances.
//   fork     ForkFacilitator  — against a local anvil fork of Base. Checks the
//            signature, the payer's balance and the nonce, then submits
//            transferWithAuthorization from one of anvil's unlocked dev
//            accounts (anvil holds those; this code has no key).
//   testnet  HttpFacilitator  — a facilitator's HTTP API (POST /verify and
//            POST /settle, x402 v2 bodies), by default the public
//            https://x402.org/facilitator on Base Sepolia.

import { concat, encodeFunctionData, keccak256, parseSignature, recoverTypedDataAddress, toHex, type Address, type Hex, type PublicClient } from "viem";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "./x402.js";
import { X402_VERSION } from "./x402.js";

export interface Facilitator {
  readonly kind: "fake" | "fork" | "http";
  verify(p: PaymentPayload, r: PaymentRequirements): Promise<VerifyResponse>;
  settle(p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse>;
}

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export function chainIdOf(network: string): number {
  const m = /^eip155:(\d+)$/.exec(network);
  if (!m) throw new Error(`not an EVM network id: ${network}`);
  return Number(m[1]);
}

/** Recover the signer of the ERC-3009 authorization (EOA signatures). */
export async function recoverPayer(p: PaymentPayload, r: PaymentRequirements): Promise<Address> {
  const a = p.payload.authorization;
  return recoverTypedDataAddress({
    domain: { name: r.extra.name, version: r.extra.version, chainId: chainIdOf(r.network), verifyingContract: r.asset as Address },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: { from: a.from as Address, to: a.to as Address, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce as Hex },
    signature: p.payload.signature as Hex,
  });
}

async function signatureCheck(p: PaymentPayload, r: PaymentRequirements): Promise<VerifyResponse | null> {
  let signer: string;
  try { signer = await recoverPayer(p, r); } catch (e) {
    return { isValid: false, invalidReason: "invalid_signature", invalidMessage: `the signature does not parse: ${(e as Error).message.split("\n")[0]}` };
  }
  if (signer.toLowerCase() !== p.payload.authorization.from.toLowerCase()) {
    return { isValid: false, invalidReason: "invalid_signature", invalidMessage: `the signature recovers ${signer}, not authorization.from ${p.payload.authorization.from}`, payer: p.payload.authorization.from };
  }
  return null;
}

export class FakeFacilitator implements Facilitator {
  readonly kind = "fake" as const;
  private used = new Set<string>();
  async verify(p: PaymentPayload, r: PaymentRequirements): Promise<VerifyResponse> {
    const bad = await signatureCheck(p, r);
    if (bad) return bad;
    const key = `${p.payload.authorization.from.toLowerCase()}:${p.payload.authorization.nonce.toLowerCase()}`;
    if (this.used.has(key)) return { isValid: false, invalidReason: "nonce_already_used", invalidMessage: "this authorization nonce was already settled", payer: p.payload.authorization.from };
    return { isValid: true, payer: p.payload.authorization.from };
  }
  async settle(p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse> {
    const v = await this.verify(p, r);
    if (!v.isValid) return { success: false, errorReason: v.invalidReason, errorMessage: v.invalidMessage, payer: v.payer, transaction: "", network: r.network };
    this.used.add(`${p.payload.authorization.from.toLowerCase()}:${p.payload.authorization.nonce.toLowerCase()}`);
    // A labelled stand-in, never a real transaction hash.
    const transaction = keccak256(concat([toHex("sato-template/x402-seller fixture settlement"), p.payload.authorization.nonce as Hex]));
    return { success: true, payer: p.payload.authorization.from, transaction, network: r.network, amount: p.payload.authorization.value };
  }
}

export const USDC_3009_ABI = [
  { type: "function", name: "authorizationState", stateMutability: "view", inputs: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function", name: "transferWithAuthorization", stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

/** Submits through anvil's unlocked dev account on a LOCAL fork. Refuses any other chain id. */
export class ForkFacilitator implements Facilitator {
  readonly kind = "fork" as const;
  constructor(private client: PublicClient, private rpcRequest: (method: string, params: unknown[]) => Promise<unknown>) {}

  async verify(p: PaymentPayload, r: PaymentRequirements): Promise<VerifyResponse> {
    const bad = await signatureCheck(p, r);
    if (bad) return bad;
    const a = p.payload.authorization;
    const used = await this.client.readContract({ address: r.asset as Address, abi: USDC_3009_ABI, functionName: "authorizationState", args: [a.from as Address, a.nonce as Hex] });
    if (used) return { isValid: false, invalidReason: "nonce_already_used", invalidMessage: "the token reports this authorization nonce as used", payer: a.from };
    const bal = await this.client.readContract({ address: r.asset as Address, abi: USDC_3009_ABI, functionName: "balanceOf", args: [a.from as Address] });
    if (bal < BigInt(a.value)) return { isValid: false, invalidReason: "insufficient_funds", invalidMessage: `payer holds ${bal} base units, the authorization moves ${a.value}`, payer: a.from };
    return { isValid: true, payer: a.from };
  }

  async settle(p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse> {
    const id = await this.client.getChainId();
    if (id !== chainIdOf(r.network)) throw new Error(`fork facilitator: RPC answers chain id ${id}, requirements name ${r.network}`);
    const v = await this.verify(p, r);
    if (!v.isValid) return { success: false, errorReason: v.invalidReason, errorMessage: v.invalidMessage, payer: v.payer, transaction: "", network: r.network };
    const a = p.payload.authorization;
    const sig = parseSignature(p.payload.signature as Hex);
    const accounts = (await this.rpcRequest("eth_accounts", [])) as Address[];
    if (!accounts?.length) throw new Error("fork facilitator: the fork exposes no unlocked dev account (is this anvil?)");
    const data = encodeFunctionData({
      abi: USDC_3009_ABI, functionName: "transferWithAuthorization",
      args: [a.from as Address, a.to as Address, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce as Hex, Number(sig.v ?? BigInt(sig.yParity + 27)), sig.r, sig.s],
    });
    const hash = (await this.rpcRequest("eth_sendTransaction", [{ from: accounts[0], to: r.asset, data }])) as Hex;
    const receipt = await this.client.waitForTransactionReceipt({ hash, timeout: 30_000 });
    if (receipt.status !== "success") return { success: false, errorReason: "transaction_reverted", errorMessage: `transferWithAuthorization reverted in ${hash}`, payer: a.from, transaction: hash, network: r.network };
    return { success: true, payer: a.from, transaction: hash, network: r.network, amount: a.value };
  }
}

export const USER_AGENT = "sato-template/x402-seller@0.1.0";

export class HttpFacilitator implements Facilitator {
  readonly kind = "http" as const;
  constructor(private baseUrl: string, private timeoutMs = 15_000) {}
  private async post<T>(path: string, p: PaymentPayload, r: PaymentRequirements): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": USER_AGENT },
      body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload: p, paymentRequirements: r }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new Error(`facilitator ${path}: HTTP ${res.status}, not JSON`); }
    if (!res.ok && !(body && typeof body === "object" && ("isValid" in body || "success" in body))) throw new Error(`facilitator ${path}: HTTP ${res.status}`);
    return body as T;
  }
  verify(p: PaymentPayload, r: PaymentRequirements) { return this.post<VerifyResponse>("verify", p, r); }
  settle(p: PaymentPayload, r: PaymentRequirements) { return this.post<SettleResponse>("settle", p, r); }
}
