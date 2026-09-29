import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SellerConfig } from "../src/config.js";
import { bazaarExtension, decodeHeader, encodeHeader, paymentRequired, requirementsFor, sellerCheck, type PaymentPayload } from "../src/x402.js";

const config = JSON.parse(readFileSync("config.json", "utf8")) as SellerConfig;
const route = config.routes[0];
const net = config.networks.fork;
const req = requirementsFor(route, net, config.service, config.max_timeout_seconds);
const valid = (JSON.parse(readFileSync("fixtures/payments/valid.json", "utf8")) as { payload: PaymentPayload }).payload;
const NOW = Date.parse("2026-09-28T00:00:00Z") / 1000;
const clone = (): PaymentPayload => JSON.parse(JSON.stringify(valid));

test("headers round-trip as base64 JSON", () => {
  const offer = paymentRequired(route, net, config.service, 60);
  assert.deepEqual(decodeHeader(encodeHeader(offer)), offer);
});

test("the offer is x402 v2 exact, priced from config.json", () => {
  const offer = paymentRequired(route, net, config.service, 60);
  assert.equal(offer.x402Version, 2);
  assert.equal(offer.accepts.length, 1);
  assert.deepEqual(offer.accepts[0], { scheme: "exact", network: "eip155:8453", asset: net.asset, amount: route.price_base_units, payTo: config.service.pay_to, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } });
  assert.equal(offer.resource.url, "http://localhost:4021/api/item");
});

test("the bazaar extension names the method and the query", () => {
  const b = bazaarExtension(route).bazaar as { info: { input: Record<string, unknown> } };
  assert.deepEqual(b.info.input, { type: "http", method: "GET", queryParams: { id: "x402-v2" } });
});

test("sellerCheck accepts the fixture payment for this offer", () => {
  assert.equal(sellerCheck(valid, req, NOW), null);
});

const cases: [string, (p: PaymentPayload) => void, string][] = [
  ["version", (p) => { p.x402Version = 1; }, "unsupported_version"],
  ["scheme", (p) => { (p.accepted as { scheme: string }).scheme = "upto"; }, "scheme_not_accepted"],
  ["network", (p) => { p.accepted.network = "eip155:1"; }, "network_not_accepted"],
  ["asset", (p) => { p.accepted.asset = "0x4200000000000000000000000000000000000006"; }, "asset_not_accepted"],
  ["payee", (p) => { p.payload.authorization.to = "0x0000000000000000000000000000000000000001"; }, "wrong_payee"],
  ["over price", (p) => { p.payload.authorization.value = "1001"; }, "amount_exceeds_price"],
  ["under price", (p) => { p.payload.authorization.value = "999"; }, "amount_below_price"],
  ["not yet valid", (p) => { p.payload.authorization.validAfter = String(NOW + 100); }, "authorization_not_yet_valid"],
  ["expired", (p) => { p.payload.authorization.validBefore = String(NOW + 3); }, "authorization_expired"],
  ["malformed", (p) => { (p as { payload: unknown }).payload = {}; }, "malformed_payload"],
];
for (const [name, mutate, reason] of cases) {
  test(`sellerCheck refuses: ${name} -> ${reason}`, () => {
    const p = clone();
    mutate(p);
    assert.equal(sellerCheck(p, req, NOW)?.reason, reason);
  });
}
