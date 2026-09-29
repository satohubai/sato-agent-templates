// The payment gate end to end, offline. The BUYER here signs with a key made
// for this test run and discarded; the seller code under test never signs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Kit } from "@satohub/kit";
import { privateKeyToAccount } from "viem/accounts";
import { toHex, type Hex } from "viem";
import type { SellerConfig } from "../src/config.js";
import { FakeFacilitator, HttpFacilitator, TRANSFER_WITH_AUTHORIZATION_TYPES } from "../src/facilitator.js";
import { handle, type GateDeps } from "../src/server.js";
import { decodeHeader, encodeHeader, requirementsFor, type PaymentPayload, type PaymentRequired, type SettleResponse } from "../src/x402.js";

const config = JSON.parse(readFileSync("config.json", "utf8")) as SellerConfig;
const net = config.networks.fork;
const route = config.routes[0];
const NOW_MS = Date.parse("2026-09-28T00:00:00Z");
const buyer = privateKeyToAccount(toHex(randomBytes(32)) as Hex);

async function pay(value = route.price_base_units): Promise<PaymentPayload> {
  const req = requirementsFor(route, net, config.service, config.max_timeout_seconds);
  const authorization = { from: buyer.address, to: config.service.pay_to, value, validAfter: "0", validBefore: String(NOW_MS / 1000 + 300), nonce: toHex(randomBytes(32)) };
  const signature = await buyer.signTypedData({
    domain: { name: req.extra.name, version: req.extra.version, chainId: 8453, verifyingContract: req.asset as Hex },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES, primaryType: "TransferWithAuthorization",
    message: { from: buyer.address, to: authorization.to as Hex, value: BigInt(value), validAfter: 0n, validBefore: BigInt(authorization.validBefore), nonce: authorization.nonce as Hex },
  });
  return { x402Version: 2, accepted: req, payload: { signature, authorization } };
}

function deps(confirmed = true): GateDeps & { reads: unknown[] } {
  const reads: unknown[] = [];
  const kit = { read: async (_id: string, input: unknown) => { reads.push(input); return { kind: "contract_read", chain: "base", block_number: "7", result: confirmed, as_of: "x" }; } } as unknown as Kit;
  return { config, net, facilitator: new FakeFacilitator(), kit, nowMs: () => NOW_MS, reads };
}
const get = (headers: Record<string, string> = {}, query: Record<string, string> = { id: "x402-v2" }) => ({ method: "GET", path: "/api/item", query, headers });

test("unpaid -> 402 with the offer in PAYMENT-REQUIRED", async () => {
  const out = await handle(get(), deps());
  assert.equal(out.status, 402);
  const offer = decodeHeader<PaymentRequired>(out.headers["PAYMENT-REQUIRED"]);
  assert.equal(offer.accepts[0].amount, route.price_base_units);
  assert.ok(offer.extensions?.bazaar);
});

test("paid -> 200, PAYMENT-RESPONSE, receipt confirmed through chain.read authorizationState", async () => {
  const d = deps();
  const p = await pay();
  const out = await handle(get({ "PAYMENT-SIGNATURE": encodeHeader(p) }), d);
  assert.equal(out.status, 200);
  assert.equal((out.body as { id: string }).id, "x402-v2");
  const settled = decodeHeader<SettleResponse>(out.headers["PAYMENT-RESPONSE"]);
  assert.equal(settled.success, true);
  assert.equal(out.receipt?.confirmation.status, "confirmed");
  assert.equal(out.receipt?.amount, route.price_base_units);
  assert.deepEqual((d.reads[0] as { args: unknown[] }).args, [buyer.address, p.payload.authorization.nonce]);
});

test("the legacy X-PAYMENT header is read too", async () => {
  const out = await handle(get({ "X-PAYMENT": encodeHeader(await pay()) }), deps());
  assert.equal(out.status, 200);
});

test("a settlement the chain does not confirm is reported unconfirmed", async () => {
  const out = await handle(get({ "PAYMENT-SIGNATURE": encodeHeader(await pay()) }), deps(false));
  assert.equal(out.receipt?.confirmation.status, "unconfirmed");
});

test("an API error is never charged, and the same payment still works afterwards", async () => {
  const d = deps();
  const p = await pay();
  const miss = await handle(get({ "PAYMENT-SIGNATURE": encodeHeader(p) }, { id: "nope" }), d);
  assert.equal(miss.status, 404);
  assert.equal((miss.body as { charged: boolean }).charged, false);
  assert.equal(miss.headers["PAYMENT-RESPONSE"], undefined);
  const hit = await handle(get({ "PAYMENT-SIGNATURE": encodeHeader(p) }), d);
  assert.equal(hit.status, 200);
});

test("over-price is refused by the seller before the facilitator is asked", async () => {
  const d = deps();
  let asked = false;
  d.facilitator = { kind: "fake", verify: async () => { asked = true; return { isValid: true }; }, settle: async () => { throw new Error("no"); } };
  const out = await handle(get({ "PAYMENT-SIGNATURE": encodeHeader(await pay("2000")) }), d);
  assert.equal(out.status, 402);
  assert.equal((out.body as { refused: { reason: string } }).refused.reason, "amount_exceeds_price");
  assert.equal(asked, false);
});

test("free /health, unknown path 404, wrong method 405", async () => {
  assert.equal((await handle({ method: "GET", path: "/health", query: {}, headers: {} }, deps())).status, 200);
  assert.equal((await handle({ method: "GET", path: "/nope", query: {}, headers: {} }, deps())).status, 404);
  assert.equal((await handle({ method: "POST", path: "/api/item", query: {}, headers: {} }, deps())).status, 405);
});

test("HttpFacilitator posts x402 v2 verify/settle bodies (in-test server)", async () => {
  const seen: { url: string; body: { x402Version: number; paymentRequirements: { amount: string } } }[] = [];
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(b) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/verify" ? { isValid: true, payer: buyer.address } : { success: true, transaction: "0xabc", network: "eip155:84532", payer: buyer.address }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  try {
    const f = new HttpFacilitator(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/`, 3000);
    const p = await pay();
    assert.equal((await f.verify(p, p.accepted)).isValid, true);
    assert.equal((await f.settle(p, p.accepted)).transaction, "0xabc");
    assert.deepEqual(seen.map((s) => s.url), ["/verify", "/settle"]);
    assert.equal(seen[0].body.x402Version, 2);
    assert.equal(seen[0].body.paymentRequirements.amount, route.price_base_units);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});
