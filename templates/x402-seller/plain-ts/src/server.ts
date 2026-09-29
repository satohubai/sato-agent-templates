// The payment gate, as one function from a request to a response, so fixture
// mode, tests and the real HTTP server run the same code:
//
//   free route (/health)            -> 200
//   paid route, no payment header   -> 402 + PAYMENT-REQUIRED (the offer)
//   payment for a different offer   -> 402 + the seller's refusal reason (no facilitator call)
//   facilitator rejects it          -> 402 + the facilitator's reason
//   API answers non-200             -> that answer, NOT settled (an error is never charged)
//   API answers 200                 -> settle -> confirm through chain.read -> 200
//                                      + PAYMENT-RESPONSE + a settlement receipt

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Kit } from "@satohub/kit";
import type { NetworkConfig, SellerConfig } from "./config.js";
import { confirmSettlement, type Confirmation } from "./confirm.js";
import type { Facilitator } from "./facilitator.js";
import { handleApi } from "./api.js";
import {
  decodeHeader, encodeHeader, HEADER_PAYMENT, HEADER_PAYMENT_LEGACY, HEADER_REQUIRED, HEADER_RESPONSE,
  paymentRequired, requirementsFor, sellerCheck, type PaymentPayload, type SettleResponse,
} from "./x402.js";

export type GateRequest = { method: string; path: string; query: Record<string, string>; headers: Record<string, string | undefined> };
export type GateResponse = { status: number; headers: Record<string, string>; body: unknown; receipt?: SettlementReceipt };

export type SettlementReceipt = {
  schema: "sato.x402-seller.receipt/v1";
  route: string;
  network: string;
  asset: string;
  amount: string;
  pay_to: string;
  payer: string;
  nonce: string;
  transaction: string;
  facilitator: Facilitator["kind"];
  confirmation: Confirmation;
  settled_at: string;
};

export type GateDeps = { config: SellerConfig; net: NetworkConfig; facilitator: Facilitator; kit: Kit; nowMs: () => number };

const header = (h: GateRequest["headers"], name: string) => h[name] ?? h[name.toLowerCase()];

function refuse(deps: GateDeps, routeIdx: number, reason: string, message: string, payer?: string): GateResponse {
  const route = deps.config.routes[routeIdx];
  const offer = paymentRequired(route, deps.net, deps.config.service, deps.config.max_timeout_seconds, reason);
  return {
    status: 402,
    headers: { [HEADER_REQUIRED]: encodeHeader(offer), "content-type": "application/json" },
    body: { ...offer, refused: { reason, message, ...(payer ? { payer } : {}) } },
  };
}

export async function handle(req: GateRequest, deps: GateDeps): Promise<GateResponse> {
  const json = { "content-type": "application/json" };
  if (req.path === "/health") return { status: 200, headers: json, body: { ok: true } };
  const idx = deps.config.routes.findIndex((r) => r.path === req.path);
  if (idx < 0) return { status: 404, headers: json, body: { error: "not_found" } };
  const route = deps.config.routes[idx];
  if (req.method !== route.method) return { status: 405, headers: { ...json, allow: route.method }, body: { error: "method_not_allowed" } };

  const raw = header(req.headers, HEADER_PAYMENT) ?? header(req.headers, HEADER_PAYMENT_LEGACY);
  if (!raw) {
    const offer = paymentRequired(route, deps.net, deps.config.service, deps.config.max_timeout_seconds, `${HEADER_PAYMENT} header is required`);
    return { status: 402, headers: { [HEADER_REQUIRED]: encodeHeader(offer), ...json }, body: offer };
  }

  let payment: PaymentPayload;
  try { payment = decodeHeader<PaymentPayload>(raw); } catch { return refuse(deps, idx, "malformed_payload", `${HEADER_PAYMENT} is not base64 JSON`); }
  const requirements = requirementsFor(route, deps.net, deps.config.service, deps.config.max_timeout_seconds);
  const own = sellerCheck(payment, requirements, Math.floor(deps.nowMs() / 1000));
  if (own) return refuse(deps, idx, own.reason, own.message);

  const verified = await deps.facilitator.verify(payment, requirements);
  if (!verified.isValid) return refuse(deps, idx, verified.invalidReason ?? "payment_invalid", verified.invalidMessage ?? "the facilitator rejected the payment", verified.payer);

  const api = handleApi(req.path, req.query);
  if (api.status !== 200) return { status: api.status, headers: json, body: { ...(api.body as object), charged: false } };

  const settled: SettleResponse = await deps.facilitator.settle(payment, requirements);
  if (!settled.success) return refuse(deps, idx, settled.errorReason ?? "settlement_failed", settled.errorMessage ?? "the facilitator could not settle the payment", settled.payer);

  const a = payment.payload.authorization;
  const confirmation = await confirmSettlement(deps.kit, deps.net.chain, requirements.asset, a.from, a.nonce);
  const receipt: SettlementReceipt = {
    schema: "sato.x402-seller.receipt/v1",
    route: `${route.method} ${route.path}`,
    network: requirements.network,
    asset: requirements.asset,
    amount: a.value,
    pay_to: requirements.payTo,
    payer: settled.payer ?? a.from,
    nonce: a.nonce,
    transaction: settled.transaction,
    facilitator: deps.facilitator.kind,
    confirmation,
    settled_at: new Date(deps.nowMs()).toISOString(),
  };
  return { status: 200, headers: { ...json, [HEADER_RESPONSE]: encodeHeader(settled) }, body: api.body, receipt };
}

/** The real HTTP server (fork and testnet modes). */
export function serve(deps: GateDeps, port: number, onReceipt: (r: SettlementReceipt) => void) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
      headers[HEADER_PAYMENT] = headers[HEADER_PAYMENT.toLowerCase()];
      headers[HEADER_PAYMENT_LEGACY] = headers[HEADER_PAYMENT_LEGACY.toLowerCase()];
      const out = await handle({ method: req.method ?? "GET", path: url.pathname, query: Object.fromEntries(url.searchParams), headers }, deps);
      if (out.receipt) onReceipt(out.receipt);
      res.writeHead(out.status, { ...out.headers, "access-control-expose-headers": `${HEADER_REQUIRED}, ${HEADER_RESPONSE}` });
      res.end(JSON.stringify(out.body));
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "facilitator_error", message: "the payment could not be processed; nothing was settled", detail: (e as Error).message.split("\n")[0] }));
    }
  });
  server.listen(port);
  return server;
}
