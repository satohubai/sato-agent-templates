import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePolicyFile } from "@satohub/kit";
import { parseArgs, parseConfig, UsageError } from "../src/config.js";
import { kitPolicy, loadPolicy } from "../src/policy.js";
import { ledgerPreflight, SpendLedger } from "../src/spend.js";
import { lamportsToSol, solToLamports, usdcToUsd, WSOL_MINT } from "../src/tokens.js";
import { decide, impliedPriceUsd, loadState, saveState } from "../src/watch.js";

// ── arguments: there is no way to sign from here ─────────────────────────────

test("args: fixture is the default and needs nothing", () => {
  const a = parseArgs([]);
  assert.equal(a.mode, "fixture");
  assert.equal(a.accept_mainnet_risk, false);
});

test("args: live mode refuses to start without --accept-mainnet-risk", () => {
  assert.throws(() => parseArgs(["--mode", "live"]), /--accept-mainnet-risk/);
  assert.equal(parseArgs(["--mode", "live", "--accept-mainnet-risk"]).mode, "live");
});

test("args: --accept-mainnet-risk without live mode, --record without live mode, and a 'mainnet' mode are all refused", () => {
  assert.throws(() => parseArgs(["--accept-mainnet-risk"]), UsageError);
  assert.throws(() => parseArgs(["--record"]), /only accepted with --mode live/);
  assert.throws(() => parseArgs(["--mode", "mainnet"]), /no "mainnet" mode/);
});

test("args: there is no --execute, --sign or --keypair", () => {
  for (const f of ["--execute", "--sign", "--keypair", "--private-key"]) {
    assert.throws(() => parseArgs([f]), (e: Error) => e instanceof UsageError && /stops at an unsigned transaction/.test(e.message), f);
  }
});

// ── config.json ──────────────────────────────────────────────────────────────

const shipped = () => JSON.parse(readFileSync("config.json", "utf8"));

test("config: the shipped config parses and watches no wallet until you name one", () => {
  const c = parseConfig(shipped());
  assert.equal(c.wallet, null);
  assert.equal(c.sell_sol, "0.1");
  assert.equal(c.venue, "sato");
  assert.equal(c.reference_price_usd, null);
});

test("config: a public address is accepted, a secret key is refused with an explanation, a key-shaped field name is refused", () => {
  assert.equal(parseConfig({ wallet: "7PdKhpKz7T39vZHFL1UfcYNDsLvay6hp4KPQq1aUckFf" }).wallet, "7PdKhpKz7T39vZHFL1UfcYNDsLvay6hp4KPQq1aUckFf");
  const secretish = "5".repeat(88);
  assert.throws(() => parseConfig({ wallet: secretish }), /looks like a secret key, not an address/);
  assert.throws(() => parseConfig({ wallet: "short" }), /public address/);
  for (const k of ["private_key", "secret_key", "mnemonic", "seed_phrase", "keypair", "signer"]) {
    assert.throws(() => parseConfig({ [k]: "x" }), /looks like a key field/, k);
  }
  assert.throws(() => parseConfig({ unknown: 1 }), /unknown property/);
});

test("config: amounts, threshold, venue and slippage are checked", () => {
  assert.throws(() => parseConfig({ sell_sol: "0" }), /sell_sol/);
  assert.throws(() => parseConfig({ sell_sol: "0.1234567891" }), /sell_sol/);
  assert.throws(() => parseConfig({ sell_sol: 0.1 }), /sell_sol/);
  assert.equal(parseConfig({ keep_sol: "0" }).keep_sol, "0");
  assert.throws(() => parseConfig({ drop_pct: 0 }), /drop_pct/);
  assert.throws(() => parseConfig({ drop_pct: 100 }), /drop_pct/);
  assert.throws(() => parseConfig({ venue: "lifi" }), /venue/);
  assert.throws(() => parseConfig({ slippage_bps: 5001 }), /slippage_bps/);
  assert.throws(() => parseConfig({ reference_price_usd: -1 }), /reference_price_usd/);
});

test("tokens: SOL amounts convert exactly and round-trip", () => {
  assert.equal(solToLamports("0.1"), 100_000_000n);
  assert.equal(solToLamports("12.000000001"), 12_000_000_001n);
  assert.equal(lamportsToSol(100_000_000n), "0.1");
  assert.equal(lamportsToSol(12_000_000_001n), "12.000000001");
  assert.equal(lamportsToSol(5n * 10n ** 9n), "5");
  assert.equal(usdcToUsd("10905777"), 10.905777);
  assert.throws(() => solToLamports("1e3"));
});

// ── policy.json ──────────────────────────────────────────────────────────────

test("policy: the shipped file is valid sato.policy/v1, defaults to fork and carries a per-swap and a daily cap", () => {
  const raw = JSON.parse(readFileSync("policy.json", "utf8"));
  const parsed = parsePolicyFile(raw);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  const p = loadPolicy("policy.json", "fixture");
  assert.equal(p.network, "fork");
  assert.deepEqual(p.allow_chains, ["solana"]);
  assert.deepEqual(p.allow_tokens, [`solana:${WSOL_MINT}`]);
  assert.equal(p.max_usd_per_trade, 15);
  assert.equal(p.max_usd_per_day, 20);
  assert.equal(p.unknown_verdict, "refuse");
  assert.equal(p.require_simulation, true);
});

test("policy: live mode will not start on a fork policy; the kit is told mainnet either way", () => {
  assert.throws(() => loadPolicy("policy.json", "live"), /says "network": "fork"/);
  const dir = mkdtempSync(join(tmpdir(), "sgs-pol-"));
  const f = (over: object) => {
    const file = join(dir, `p${Math.random()}.json`);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync("policy.json", "utf8")), ...over }));
    return file;
  };
  assert.equal(loadPolicy(f({ network: "mainnet" }), "live").network, "mainnet");
  assert.throws(() => loadPolicy(f({ network: "testnet" }), "fixture"), /no Solana testnet/);
  assert.equal(kitPolicy(loadPolicy("policy.json", "fixture")).network, "mainnet");
});

test("policy: a missing cap, an unknown_verdict of allow, or a policy that does not name SOL is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "sgs-pol-"));
  const base = JSON.parse(readFileSync("policy.json", "utf8"));
  const write = (over: object) => {
    const file = join(dir, `q${Math.random()}.json`);
    writeFileSync(file, JSON.stringify({ ...base, ...over }));
    return file;
  };
  assert.throws(() => loadPolicy(write({ max_usd_per_day: null }), "fixture"), /daily cap/);
  assert.throws(() => loadPolicy(write({ max_usd_per_trade: null }), "fixture"), /per-swap cap/);
  assert.throws(() => loadPolicy(write({ unknown_verdict: "allow" }), "fixture"), /unknown_verdict/);
  assert.throws(() => loadPolicy(write({ allow_tokens: ["solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"] }), "fixture"), /allow_tokens must include/);
});

// ── the watch ────────────────────────────────────────────────────────────────

test("watch: the price is the USDC out per SOL in", () => {
  assert.equal(impliedPriceUsd(100_000_000n, "10905777").toFixed(4), "109.0578");
  assert.equal(impliedPriceUsd(10n * 10n ** 9n, "1090225255").toFixed(4), "109.0225");
});

test("watch: a drop at or past the threshold fires, below it does not, and no reference or no price never fires", () => {
  const ref = { usd: 120, source: "config" as const };
  assert.equal(decide(114, ref, 5).fire, true, "exactly 5%");
  assert.equal(decide(114.01, ref, 5).fire, false);
  const d = decide(100, ref, 5);
  assert.ok(d.fire && d.drop_pct === 16.67);
  assert.equal(decide(130, ref, 5).fire, false, "a rise is not a drop");
  const noRef = decide(100, null, 5);
  assert.ok(!noRef.fire && /no reference price yet/.test(noRef.why));
  const noPrice = decide(null, ref, 5);
  assert.ok(!noPrice.fire && /no price could be read/.test(noPrice.why));
});

test("watch: state round-trips and a corrupt state file is an error, not a silent reset", () => {
  const dir = mkdtempSync(join(tmpdir(), "sgs-state-"));
  assert.deepEqual(loadState(dir), { high_price_usd: null });
  saveState(dir, { high_price_usd: 123.45 });
  assert.deepEqual(loadState(dir), { high_price_usd: 123.45 });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ high_price_usd: "x" }));
  assert.throws(() => loadState(dir), /positive number or null/);
});

// ── the daily total ──────────────────────────────────────────────────────────

test("spend: totals add up within a UTC day, reset on the next, and persist to the ledger file", () => {
  let now = Date.parse("2026-10-09T23:59:00Z");
  const dir = mkdtempSync(join(tmpdir(), "sgs-ledger-"));
  const file = join(dir, "ledger.json");
  const l = new SpendLedger(() => now, file);
  assert.equal(l.spentToday(), 0);
  l.add(10);
  l.add(5.5);
  assert.equal(l.spentToday(), 15.5);
  assert.equal(new SpendLedger(() => now, file).spentToday(), 15.5, "a new process reads the same total");
  now = Date.parse("2026-10-10T00:00:01Z");
  assert.equal(l.spentToday(), 0);
  assert.equal(new SpendLedger(() => now, file).spentToday(), 0);
});

test("spend: a ledger file that cannot be read makes the total unknown, and the pre-flight refuses on unknown", () => {
  const dir = mkdtempSync(join(tmpdir(), "sgs-ledger-"));
  const file = join(dir, "ledger.json");
  writeFileSync(file, "{ not json");
  const l = new SpendLedger(() => 0, file);
  assert.equal(l.spentToday(), null);
  assert.match(l.problem() ?? "", /could not be read/);
  const policy = kitPolicy(loadPolicy("policy.json", "fixture"));
  const facts = { action: "solana.swap.prepare", chain: "solana", network: "mainnet", token: WSOL_MINT, token_amount_base_units: "100000000", usd_value: 10, usd_spent_today: 0, venue: "sato", slippage_bps: 50, simulation: { ok: true, method: "simulateTransaction", block: "1", gas_estimate: "1", error: null, as_of: "x" }, ttl_s: 120 } as never;
  const res = ledgerPreflight(l)(policy, facts);
  assert.equal(res.ok, false);
  assert.ok(res.refusals.some((r) => r.rule === "unknown_verdict"));
});

test("spend: the larger of the kit's executed total and this agent's prepared total counts", () => {
  const l = new SpendLedger(() => 0);
  l.add(12);
  const policy = kitPolicy(loadPolicy("policy.json", "fixture"));
  const facts = (spent: number | null) =>
    ({ action: "solana.swap.prepare", chain: "solana", network: "mainnet", token: WSOL_MINT, token_amount_base_units: "100000000", usd_value: 10, usd_spent_today: spent, venue: "sato", slippage_bps: 50, simulation: { ok: true, method: "simulateTransaction", block: "1", gas_estimate: "1", error: null, as_of: "x" }, ttl_s: 120 }) as never;
  const a = ledgerPreflight(l)(policy, facts(0));
  assert.ok(a.refusals.some((r) => r.rule === "max_usd_per_day" && r.observed === "22"), "12 prepared + 10 = 22 over 20");
  const b = ledgerPreflight(new SpendLedger(() => 0))(policy, facts(15));
  assert.ok(b.refusals.some((r) => r.rule === "max_usd_per_day" && r.observed === "25"), "15 executed + 10 = 25 over 20");
  const c = ledgerPreflight(new SpendLedger(() => 0))(policy, facts(null));
  assert.ok(c.refusals.some((r) => r.rule === "unknown_verdict"), "the kit's unknown stays unknown");
});
