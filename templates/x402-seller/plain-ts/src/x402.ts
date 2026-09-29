// The x402 v2 wire format this seller speaks, written out rather than hidden
// behind a framework so every field is visible:
//
//   402 response   PAYMENT-REQUIRED: base64(JSON PaymentRequired), same JSON in the body
//   paid request   PAYMENT-SIGNATURE: base64(JSON PaymentPayload)   (X-PAYMENT is read too)
//   200 response   PAYMENT-RESPONSE: base64(JSON SettleResponse)
//
// Scheme `exact` on EVM: the payload carries an ERC-3009 transferWithAuthorization
// signed by the buyer. The seller never signs anything; a facilitator verifies
// and submits it (src/facilitator.ts).

import type { NetworkConfig, RouteConfig, ServiceConfig } from "./config.js";

export const X402_VERSION = 2;
export const HEADER_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_PAYMENT = "PAYMENT-SIGNATURE";
export const HEADER_PAYMENT_LEGACY = "X-PAYMENT";
export const HEADER_RESPONSE = "PAYMENT-RESPONSE";

export type ResourceInfo = { url: string; description?: string; mimeType?: string; serviceName?: string; tags?: string[] };

export type PaymentRequirements = {
  scheme: "exact";
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
};

export type PaymentRequired = {
  x402Version: number;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
};

export type ExactAuthorization = { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string };

export type PaymentPayload = {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: { signature: string; authorization: ExactAuthorization };
  extensions?: Record<string, unknown>;
};

export type VerifyResponse = { isValid: boolean; invalidReason?: string; invalidMessage?: string; payer?: string };
export type SettleResponse = { success: boolean; errorReason?: string; errorMessage?: string; payer?: string; transaction: string; network: string; amount?: string };

export function encodeHeader(v: unknown): string {
  return Buffer.from(JSON.stringify(v), "utf8").toString("base64");
}

export function decodeHeader<T>(h: string): T {
  return JSON.parse(Buffer.from(h, "base64").toString("utf8")) as T;
}

export function requirementsFor(route: RouteConfig, net: NetworkConfig, service: ServiceConfig, maxTimeoutSeconds: number): PaymentRequirements {
  return {
    scheme: "exact",
    network: net.network,
    asset: net.asset,
    amount: route.price_base_units,
    payTo: service.pay_to,
    maxTimeoutSeconds,
    extra: { name: net.eip712.name, version: net.eip712.version },
  };
}

export function resourceFor(route: RouteConfig, service: ServiceConfig): ResourceInfo {
  return {
    url: `${service.public_url.replace(/\/$/, "")}${route.path}`,
    description: route.description,
    mimeType: route.mime_type,
    serviceName: service.name,
    tags: service.tags,
  };
}

/**
 * The Bazaar discovery extension for one GET route, in the shape
 * `declareDiscoveryExtension` from @x402/extensions produces, with `method`
 * already filled in (the enrich step a framework adapter would run). A
 * facilitator that catalogues resources reads it from the payload the buyer
 * echoes back; nothing here submits it anywhere.
 */
export function bazaarExtension(route: RouteConfig): Record<string, unknown> {
  return {
    bazaar: {
      info: {
        input: { type: "http", method: route.method, queryParams: route.query_example },
        output: { type: "json", example: route.output_example },
      },
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          input: {
            type: "object",
            properties: {
              type: { type: "string", const: "http" },
              method: { type: "string", enum: ["GET", "HEAD", "DELETE"] },
              queryParams: { type: "object", ...route.query_schema },
            },
            required: ["type", "method"],
            additionalProperties: false,
          },
          output: {
            type: "object",
            properties: { type: { type: "string" }, example: { type: "object" } },
            required: ["type"],
          },
        },
        required: ["input"],
      },
    },
  };
}

export function paymentRequired(route: RouteConfig, net: NetworkConfig, service: ServiceConfig, maxTimeoutSeconds: number, error?: string): PaymentRequired {
  return {
    x402Version: X402_VERSION,
    ...(error ? { error } : {}),
    resource: resourceFor(route, service),
    accepts: [requirementsFor(route, net, service, maxTimeoutSeconds)],
    extensions: bazaarExtension(route),
  };
}

const lc = (s: unknown) => String(s ?? "").toLowerCase();

/**
 * The seller's own checks, BEFORE a facilitator is asked anything: the payment
 * must be for exactly this route's offer. Returns a refusal reason, or null.
 * The facilitator then checks the signature, the balance and the nonce.
 */
export function sellerCheck(p: PaymentPayload, req: PaymentRequirements, nowSeconds: number): { reason: string; message: string } | null {
  if (p?.x402Version !== X402_VERSION) return { reason: "unsupported_version", message: `x402Version ${String(p?.x402Version)}; this seller speaks ${X402_VERSION}` };
  const a = p.accepted;
  const auth = p.payload?.authorization;
  if (!a || !auth || typeof p.payload?.signature !== "string") return { reason: "malformed_payload", message: "accepted, payload.signature and payload.authorization are required" };
  if (a.scheme !== req.scheme) return { reason: "scheme_not_accepted", message: `scheme ${a.scheme}; this route accepts ${req.scheme}` };
  if (a.network !== req.network) return { reason: "network_not_accepted", message: `network ${a.network}; this route accepts ${req.network}` };
  if (lc(a.asset) !== lc(req.asset)) return { reason: "asset_not_accepted", message: `asset ${a.asset}; this route accepts ${req.asset} only` };
  if (lc(a.payTo) !== lc(req.payTo) || lc(auth.to) !== lc(req.payTo)) return { reason: "wrong_payee", message: `the authorization pays ${auth.to}; this route is paid to ${req.payTo}` };
  let value: bigint;
  try { value = BigInt(auth.value); } catch { return { reason: "malformed_payload", message: "authorization.value is not an integer" }; }
  const price = BigInt(req.amount);
  if (value > price) return { reason: "amount_exceeds_price", message: `the authorization moves ${value} base units; this route costs exactly ${price}` };
  if (value < price) return { reason: "amount_below_price", message: `the authorization moves ${value} base units; this route costs exactly ${price}` };
  if (a.amount !== req.amount) return { reason: "amount_mismatch", message: `accepted.amount ${a.amount}; this route costs ${req.amount}` };
  if (BigInt(auth.validAfter) > BigInt(nowSeconds)) return { reason: "authorization_not_yet_valid", message: `validAfter ${auth.validAfter} is after now (${nowSeconds})` };
  if (BigInt(auth.validBefore) < BigInt(nowSeconds + 6)) return { reason: "authorization_expired", message: `validBefore ${auth.validBefore} leaves under 6 seconds from now (${nowSeconds})` };
  return null;
}
