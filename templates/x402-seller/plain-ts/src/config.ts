// Command line and config.json. Every value the seller quotes (price, asset,
// payee, network) comes from config.json; nothing is inferred.

export type Mode = "fixture" | "fork" | "testnet";
export const MODES: Mode[] = ["fixture", "fork", "testnet"];

export class UsageError extends Error {}
export class ConfigError extends Error {}

export type ServiceConfig = { name: string; public_url: string; tags: string[]; pay_to: string };
export type NetworkConfig = {
  chain: "base" | "base-sepolia";
  network: string;
  asset: string;
  asset_symbol: string;
  asset_decimals: number;
  eip712: { name: string; version: string };
  facilitator: string;
};
export type RouteConfig = {
  method: "GET";
  path: string;
  price_base_units: string;
  description: string;
  mime_type: string;
  query_example: Record<string, string>;
  query_schema: Record<string, unknown>;
  output_example: Record<string, unknown>;
};
export type SellerConfig = {
  service: ServiceConfig;
  networks: { fork: NetworkConfig; testnet: NetworkConfig };
  max_timeout_seconds: number;
  routes: RouteConfig[];
};

export type Args = { mode: Mode; config: string; policy: string; out: string; port: number };

export function parseArgs(argv: string[]): Args {
  const a: Args = { mode: "fixture", config: "config.json", policy: "policy.json", out: "out", port: 4021 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new UsageError(`${k} needs a value`);
      return x;
    };
    if (k === "--mode") {
      const m = v();
      if (m === "mainnet") throw new UsageError("this template does not run on mainnet; modes are fixture, fork and testnet");
      if (!MODES.includes(m as Mode)) throw new UsageError(`--mode must be one of ${MODES.join(", ")}`);
      a.mode = m as Mode;
    } else if (k === "--config") a.config = v();
    else if (k === "--policy") a.policy = v();
    else if (k === "--out") a.out = v();
    else if (k === "--port") a.port = Number(v());
    else throw new UsageError(`unknown argument ${k}`);
  }
  if (!Number.isInteger(a.port) || a.port < 1 || a.port > 65535) throw new UsageError("--port must be 1-65535");
  return a;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^[0-9]+$/;
export const PLACEHOLDER_PAY_TO = "0x000000000000000000000000000000000000dEaD";

function checkNetwork(n: NetworkConfig, where: string, problems: string[]): void {
  if (!n || typeof n !== "object") { problems.push(`${where} is missing`); return; }
  if (n.chain !== "base" && n.chain !== "base-sepolia") problems.push(`${where}.chain must be base or base-sepolia`);
  if (!/^eip155:(8453|84532)$/.test(String(n.network))) problems.push(`${where}.network must be eip155:8453 (fork of Base) or eip155:84532 (Base Sepolia)`);
  if (!ADDR.test(String(n.asset))) problems.push(`${where}.asset must be a 0x address`);
  if (!n.eip712?.name || !n.eip712?.version) problems.push(`${where}.eip712 needs the token's EIP-712 name and version`);
  if (typeof n.facilitator !== "string" || !n.facilitator) problems.push(`${where}.facilitator is required`);
}

export function validateConfig(c: SellerConfig): string[] {
  const p: string[] = [];
  if (!c?.service?.name) p.push("service.name is required");
  if (!/^https?:\/\//.test(String(c?.service?.public_url))) p.push("service.public_url must be an http(s) URL");
  if (!ADDR.test(String(c?.service?.pay_to))) p.push("service.pay_to must be a 0x address (a public address you control; this template never holds its key)");
  if (!Array.isArray(c?.service?.tags) || c.service.tags.length > 5 || c.service.tags.some((t) => typeof t !== "string" || t.length > 32)) p.push("service.tags: up to 5 strings of at most 32 characters");
  if (String(c?.service?.name ?? "").length > 32) p.push("service.name: at most 32 characters (the Bazaar serviceName limit)");
  checkNetwork(c?.networks?.fork, "networks.fork", p);
  checkNetwork(c?.networks?.testnet, "networks.testnet", p);
  if (c?.networks?.fork && c.networks.fork.network !== "eip155:8453") p.push("networks.fork.network must be eip155:8453");
  if (c?.networks?.testnet && c.networks.testnet.network !== "eip155:84532") p.push("networks.testnet.network must be eip155:84532");
  if (!Number.isInteger(c?.max_timeout_seconds) || c.max_timeout_seconds < 10 || c.max_timeout_seconds > 600) p.push("max_timeout_seconds must be an integer from 10 to 600");
  if (!Array.isArray(c?.routes) || c.routes.length === 0) p.push("routes: at least one paid route");
  const seen = new Set<string>();
  for (const [i, r] of (c?.routes ?? []).entries()) {
    const w = `routes[${i}]`;
    if (r.method !== "GET") p.push(`${w}.method: this template serves GET routes`);
    if (!/^\/[A-Za-z0-9/_-]*$/.test(String(r.path))) p.push(`${w}.path must start with / and use path characters only`);
    if (seen.has(r.path)) p.push(`${w}.path ${r.path} is listed twice`);
    seen.add(r.path);
    if (!UINT.test(String(r.price_base_units)) || BigInt(r.price_base_units) === 0n) p.push(`${w}.price_base_units must be a positive integer string (token base units)`);
    if (!r.description || r.description.length > 500) p.push(`${w}.description: 1 to 500 characters (some facilitators refuse longer)`);
    if (!r.mime_type) p.push(`${w}.mime_type is required`);
    if (!r.query_example || typeof r.query_example !== "object") p.push(`${w}.query_example is required`);
    if (!r.query_schema || typeof r.query_schema !== "object") p.push(`${w}.query_schema is required`);
    if (!r.output_example || typeof r.output_example !== "object") p.push(`${w}.output_example is required`);
  }
  return p;
}

export function requireValidConfig(c: SellerConfig, file: string, mode: Mode): SellerConfig {
  const problems = validateConfig(c);
  if (mode === "testnet" && String(c?.service?.pay_to).toLowerCase() === PLACEHOLDER_PAY_TO.toLowerCase()) {
    problems.push("service.pay_to is still the placeholder burn address; set your own address before a testnet run");
  }
  if (problems.length) throw new ConfigError(`${file}:\n  - ${problems.join("\n  - ")}`);
  return c;
}
