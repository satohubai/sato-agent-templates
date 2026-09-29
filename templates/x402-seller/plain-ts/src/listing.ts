// The discovery listing file: one entry per paid route, carrying what an x402
// catalogue reads — the resource (url, description, mimeType, serviceName,
// tags), the accepts[] offer and the Bazaar discovery extension. This file is
// WRITTEN for the builder to submit; the template never submits or publishes it.

import type { Mode, NetworkConfig, SellerConfig } from "./config.js";
import { bazaarExtension, requirementsFor, resourceFor, X402_VERSION } from "./x402.js";

export function buildListing(config: SellerConfig, net: NetworkConfig, mode: Mode, generatedAt: string) {
  return {
    schema: "sato.x402-listing/v1",
    generated_by: "sato-template/x402-seller@0.1.0",
    generated_at: generatedAt,
    mode,
    submitted: false,
    note: "Not submitted anywhere. See README.md, 'Getting listed', for how to submit it yourself.",
    x402Version: X402_VERSION,
    service: { name: config.service.name, public_url: config.service.public_url, tags: config.service.tags },
    resources: config.routes.map((r) => ({
      resource: resourceFor(r, config.service),
      method: r.method,
      accepts: [requirementsFor(r, net, config.service, config.max_timeout_seconds)],
      extensions: bazaarExtension(r),
    })),
  };
}
