import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ACTIONS, BASE_BLOCK_HASH, CHAINS, CHAIN_VALUES, DROPPED, ETH_FORK_BLOCK, FORK_BLOCK, PYTH_ETH_USD, SOURCES, formatUnits, thirdParty } from "./actions-catalog.mjs";
import { buildRecord, expectationRpc, expectedValue, forkRpcs, sha256 } from "./check-actions.mjs";
import { custodyCell, fetchCustody, checkUrlFor } from "./lib/custody.mjs";
import { lintSkill, lintTool, schemaLintCell } from "./lib/host-lint.mjs";
import { lintDescription, lintPortableSchema } from "./lib/oda-lint.mjs";
import { parseFrontmatter, skillConformance } from "./lib/skill.mjs";
import { bareEnv } from "./lib/stdio-mcp.mjs";

const byId = Object.fromEntries(ACTIONS.map((a) => [a.id, a]));

test("catalog: at least thirty third-party actions, unique ids, every source known", () => {
  assert.ok(thirdParty().length >= 30, `${thirdParty().length} third-party actions`);
  assert.equal(new Set(ACTIONS.map((a) => a.id)).size, ACTIONS.length);
  for (const a of ACTIONS) {
    assert.ok(SOURCES[a.source], a.id);
    assert.match(a.id, /^[a-z0-9-]+:[A-Za-z0-9._-]+$/);
    assert.ok(a.id.startsWith(`${SOURCES[a.source].kind}:`), a.id);
  }
  const kit = ACTIONS.filter((a) => a.source === "sato-kit").map((a) => a.name).sort();
  assert.deepEqual(kit, ["chain_read", "erc8004_lookup", "swap_prepare", "swap_quote", "x402_prepare"]);
});

test("catalog: installs come from the npm registry or the vendored kit only", () => {
  for (const s of Object.values(SOURCES)) {
    for (const spec of s.install ?? []) assert.match(spec, /^(@[a-z0-9-]+\/)?[a-z0-9.-]+@[a-z0-9.^~-]+$|^\.\/vendor\/[a-z0-9.-]+\.tgz$/, spec);
  }
});

test("catalog: no check writes — no call names a transfer, approve, sign or send", () => {
  for (const a of ACTIONS) assert.doesNotMatch(a.name, /transfer|approve|sign|send|write|execute|wrap/i, a.id);
});

test("formatUnits", () => {
  assert.equal(formatUnits("123456789", 6), "123.456789");
  assert.equal(formatUnits("1000000", 6), "1");
  assert.equal(formatUnits("0", 6), "0");
  assert.equal(formatUnits("5", 6), "0.000005");
});

test("asserts: recorded outputs pass, wrong ones fail with a reason", () => {
  const block = byId["protocol-mcp:evm-mcp-server.get_block"];
  const ok = { content: [{ type: "text", text: JSON.stringify({ number: String(FORK_BLOCK), hash: BASE_BLOCK_HASH }) }] };
  assert.equal(block.assert(ok), null);
  assert.match(block.assert({ content: [{ type: "text", text: JSON.stringify({ number: String(FORK_BLOCK), hash: "0x00" }) }] }), /hash/);
  assert.match(block.assert({ isError: true, content: [{ type: "text", text: "boom" }] }), /error/);

  const bal = byId["agentkit-provider:erc20.get_balance"];
  assert.equal(bal.assert("Balance of USDC at 0xBBBB is 123.456789", { value: "123456789" }), null);
  assert.ok(bal.assert("Balance is 1", { value: "123456789" }));

  const feed = byId["agentkit-provider:pyth.fetch_price_feed"];
  assert.equal(feed.assert(`{"success":true,"priceFeedID":"${PYTH_ETH_USD.slice(2)}"}`), null);

  const oz = byId["protocol-mcp:openzeppelin-contracts-mcp.solidity-erc20"];
  assert.equal(oz.assert({ content: [{ type: "text", text: "contract Example is ERC20, ERC20Permit {" }] }), null);

  const read = byId["sato-kit:chain.read"];
  assert.equal(read.assert({ result: "42" }, { value: "42" }), null);
  assert.ok(read.assert({ result: "41" }, { value: "42" }));
});

test("expectedValue reads balanceOf / allowance from the fork with an injected fetch", async () => {
  const seen = [];
  const fakeFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body.params[0].data.slice(0, 10));
    return { json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x2a" }) };
  };
  const b = await expectedValue("http://fork", { kind: "erc20_balance", token: "0x1", owner: "0x0000000000000000000000000000000000000002" }, fakeFetch);
  assert.equal(b.value, "42");
  const a = await expectedValue("http://fork", { kind: "erc20_allowance", token: "0x1", owner: "0x2", spender: "0x3" }, fakeFetch);
  assert.equal(a.value, "42");
  assert.deepEqual(seen, ["0x70a08231", "0xdd62ed3e"]);
});

test("buildRecord: pass, fail with step, and our-side failures", () => {
  const a = byId["protocol-mcp:evm-mcp-server.get_chain_info"];
  const src = SOURCES[a.source];
  const custody = { result: "unknown", answers: { takes_key: "unknown", key_leaves: "unknown", moves_funds: "unknown" }, check_url: null };
  const tool = { description: "Get chain info", inputSchema: { type: "object", properties: {} }, outputSchema: null };
  const pass = buildRecord(a, src, { version: "2.0.4", call: { ok: true, output: { content: [{ type: "text", text: '{"chainId":8453}' }] } }, tool, custody });
  assert.equal(pass.checks.conformance.result, "pass");
  assert.equal(pass.upstream_version, "2.0.4");
  assert.equal(pass.description_digest, sha256("Get chain info"));
  assert.equal(pass.checks.schema_lint.result, "pass");
  const fail = buildRecord(a, src, { version: "2.0.5", call: { ok: false, step: "tool_missing", error: "gone" }, tool: undefined, custody });
  assert.deepEqual(fail.checks.conformance, { result: "fail", step: "tool_missing", detail: "gone" });
  assert.equal(fail.description_digest, null);
  assert.equal(fail.checks.schema_lint.result, "not_run");
});

test("buildRecord: a skill is checked by its frontmatter", () => {
  const a = byId["skill:uniswap-ai.swap-integration"];
  const md = "---\nname: swap-integration\ndescription: >\n  Integrate Uniswap swaps\n  into an app.\n---\n# body";
  const r = buildRecord(a, SOURCES[a.source], { version: "bff480cf4617", call: { ok: true, output: md }, custody: { result: "not_run", answers: null, check_url: null } });
  assert.equal(r.checks.conformance.result, "pass");
  assert.equal(r.description_digest, sha256("Integrate Uniswap swaps into an app."));
});

test("skill frontmatter", () => {
  assert.deepEqual(parseFrontmatter('---\nname: "x"\ndescription: hi there\n---\nbody'), { name: "x", description: "hi there" });
  assert.equal(parseFrontmatter("# no frontmatter"), null);
  assert.equal(skillConformance("---\nname: a\ndescription: d\n---", "a").result, "pass");
  assert.equal(skillConformance("---\nname: b\ndescription: d\n---", "a").step, "assert");
  assert.equal(skillConformance("---\nname: a\n---", "a").step, "assert");
  assert.equal(skillConformance("text", "a").step, "parse");
});

test("custody: answers as returned; unknown stays unknown; unreadable is not_run", async () => {
  const body = { profile: { key_access: "reads", key_egress: "unknown", fund_actions: "unknown" }, check_url: "https://satohub.ai/check/package/x" };
  assert.deepEqual(custodyCell(body), { result: "answered", answers: { takes_key: "reads", key_leaves: "unknown", moves_funds: "unknown" }, check_url: "https://satohub.ai/check/package/x" });
  assert.equal(custodyCell({ profile: { key_access: "unknown", key_egress: "unknown", fund_actions: "unknown" } }).result, "unknown");
  assert.equal(custodyCell({}).result, "not_run");
  let ua = null;
  const r = await fetchCustody("@a/b", "package", { fetchImpl: async (url, init) => { ua = init.headers["user-agent"]; assert.equal(url, checkUrlFor("@a/b", "package")); return { ok: false, status: 503 }; } });
  assert.equal(r.result, "not_run");
  assert.equal(ua, "SatoHub-templates-ci/1.0");
  assert.equal((await fetchCustody("x", "package", { fetchImpl: async () => { throw new Error("offline"); } })).result, "not_run");
});

test("host lint: facts per host", () => {
  const dotted = lintTool({ name: "swap.prepare", description: "d", inputSchema: { anyOf: [] } }, { serverToolCount: 41 });
  assert.deepEqual(dotted.hosts.openai.map((f) => f.rule), ["name_charset", "root_not_object", "root_combinator"]);
  assert.deepEqual(dotted.hosts.cursor.map((f) => f.rule), ["tool_budget"]);
  assert.ok(dotted.hosts.claude.some((f) => f.rule === "name_charset"));
  const long = lintTool({ name: "ok_name", description: "x".repeat(2049), inputSchema: { type: "object" } });
  assert.deepEqual(long.hosts.claude.map((f) => f.rule), ["description_too_long"]);
  assert.deepEqual(long.hosts.cursor, []);
  assert.equal(schemaLintCell(lintTool({ name: "ok", description: "Reads a value.", inputSchema: { type: "object", properties: {} } })).result, "pass");
  assert.equal(schemaLintCell(null).result, "not_run");
  assert.deepEqual(lintSkill({ description: "y".repeat(1025) }).hosts.claude.map((f) => f.rule), ["skill_description_too_long"]);
  // findings are facts, never judgements
  for (const f of [...dotted.hosts.openai, ...dotted.hosts.cursor, ...long.hosts.claude]) assert.doesNotMatch(f.message, /\b(unsafe|safe|dangerous|insecure)\b/i);
});

test("vendored portable lint behaves as upstream", () => {
  assert.deepEqual(lintPortableSchema({ type: "object", properties: { amount: { type: "number" }, chain: { type: "string" } } }).map((i) => i.rule), ["amount_not_string", "chain_not_enum"]);
  assert.deepEqual(lintDescription("The best route, guaranteed").map((i) => i.rule), ["description_claim"]);
});

test("third-party servers get PATH and HOME only", () => {
  assert.deepEqual(Object.keys(bareEnv({ PATH: "/bin", HOME: "/h", GITHUB_TOKEN: "t", ANY: "x" })).sort(), ["HOME", "PATH"]);
});

test("catalog: every action names its chain; Base, Ethereum and Solana each carry real reads", () => {
  for (const a of ACTIONS) assert.ok(CHAIN_VALUES.includes(a.chain), `${a.id} chain ${a.chain}`);
  const by = (c) => thirdParty().filter((a) => a.chain === c);
  for (const c of ["base", "ethereum", "solana"]) {
    assert.ok(by(c).length >= 5, `${c}: ${by(c).length}`);
    // at least three per chain are not skills: they read the chain (fork or public RPC) or its data
    assert.ok(by(c).filter((a) => SOURCES[a.source].kind !== "skill").length >= 3, c);
  }
  // a fork check only on a chain that has a fork
  for (const a of ACTIONS.filter((x) => x.needs_fork)) assert.equal(CHAINS[a.chain]?.kind, "evm", a.id);
});

test("catalog: each EVM fork is pinned (block + hash) with two public archive RPCs, and the workflow forks the same blocks", () => {
  const wf = readFileSync(new URL("../.github/workflows/actions-status.yml", import.meta.url), "utf8");
  for (const [name, c] of Object.entries(CHAINS)) {
    if (c.kind !== "evm") { assert.match(c.public_rpc, /^https:\/\//); continue; }
    assert.ok(Number.isInteger(c.fork_block) && c.fork_block > 0, name);
    assert.match(c.block_hash, /^0x[0-9a-f]{64}$/, name);
    assert.ok(c.archive_rpcs.length >= 2, name);
    for (const u of c.archive_rpcs) { assert.match(u, /^https:\/\//); assert.ok(wf.includes(u), `${u} not in the workflow`); }
    assert.ok(wf.includes(`"${c.fork_block}"`), `${name} block ${c.fork_block} not in the workflow`);
    assert.ok(wf.includes(String(c.port)), `${name} port ${c.port} not in the workflow`);
  }
  assert.equal(CHAINS.base.fork_block, FORK_BLOCK);
  assert.equal(CHAINS.ethereum.fork_block, ETH_FORK_BLOCK);
});

test("catalog: what was left out is listed with a reason", () => {
  assert.ok(DROPPED.length > 0);
  for (const d of DROPPED) { assert.ok(d.name && d.package); assert.ok(d.reason.length > 20, d.name); }
  const catalogued = new Set(Object.values(SOURCES).map((s) => s.package));
  for (const d of DROPPED) if (d.package.startsWith("@alchemy") || d.package === "helius-mcp") assert.ok(!catalogued.has(d.package));
});

test("forkRpcs: --rpc is Base, --rpc-<chain> the others; expectations read from the right place", () => {
  assert.deepEqual(forkRpcs(["--rpc", "http://b", "--rpc-ethereum", "http://e"]), { base: "http://b", ethereum: "http://e" });
  assert.deepEqual(forkRpcs(["--rpc-base", "http://b2"]), { base: "http://b2" });
  assert.deepEqual(forkRpcs([]), {});
  const spl = ACTIONS.find((a) => a.expected?.kind === "spl_mint");
  assert.equal(expectationRpc(spl, {}), CHAINS.solana.public_rpc);
  const eth = ACTIONS.find((a) => a.id === "agentkit-provider:erc20.get_balance.ethereum");
  assert.equal(expectationRpc(eth, { ethereum: "http://e" }), "http://e");
  assert.equal(expectationRpc(eth, { base: "http://b" }), null);
});

test("expectedValue: native balance, ERC-721 balance and an SPL mint's decimals", async () => {
  const calls = [];
  const fake = async (_u, init) => {
    const b = JSON.parse(init.body);
    calls.push(b.method);
    if (b.method === "getAccountInfo") return { json: async () => ({ result: { value: { data: { parsed: { info: { decimals: 6 } } } } } }) };
    return { json: async () => ({ result: "0x0a" }) };
  };
  assert.equal((await expectedValue("x", { kind: "native_balance", owner: "0x1" }, fake)).value, "10");
  assert.equal((await expectedValue("x", { kind: "erc721_balance", token: "0x1", owner: "0x2" }, fake)).value, "10");
  assert.equal((await expectedValue("x", { kind: "spl_mint", mint: "M" }, fake)).value, "6");
  assert.deepEqual(calls, ["eth_getBalance", "eth_call", "getAccountInfo"]);
  await assert.rejects(expectedValue("x", { kind: "spl_mint", mint: "M" }, async () => ({ json: async () => ({ result: { value: null } }) })), /did not parse/);
});

test("new asserts: recorded outputs pass, wrong ones fail", () => {
  const w = byId["agentkit-provider:wallet.get_wallet_details.ethereum"];
  const out = "Wallet Details:\n- Network:\n  * Chain ID: 1\n- Native Balance: 63626699643288966 WEI\n";
  assert.equal(w.assert(out, { value: "63626699643288966" }), null);
  assert.ok(w.assert(out, { value: "1" }));
  assert.ok(byId["agentkit-provider:wallet.get_wallet_details"].assert(out, { value: "63626699643288966" }), "chain id 1 is not Base");
  const nft = byId["agentkit-provider:erc721.get_balance"];
  assert.equal(nft.assert("Balance of NFTs for contract 0x03 at address 0xBB is 0", { value: "0" }), null);
  assert.ok(nft.assert("Balance of NFTs for contract 0x03 at address 0xBB is 10", { value: "0" }));
  const q = byId["agentkit-provider:sushi-router.quote.ethereum"];
  assert.equal(q.assert("Found a quote for USDC (0xa0) -> WETH (0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2)  - AmountIn: 1 USDC  - AmountOut: 0.00037 WETH"), null);
  assert.ok(q.assert("Unsupported chainId: 1"));
  const spl = byId["agentkit-provider:spl.get_balance.solana"];
  assert.equal(spl.assert("Balance for 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM is 1234.5 tokens"), null);
  assert.ok(spl.assert("Error getting SPL token balance: boom"));
  const dp = byId["protocol-mcp:dexpaprika-mcp.getTokenDetails.solana"];
  const ok = { content: [{ type: "text", text: JSON.stringify({ symbol: "USDC", decimals: 6 }) }] };
  assert.equal(dp.assert(ok, { value: "6" }), null);
  assert.match(dp.assert(ok, { value: "9" }), /decimals/);
  const dex = byId["protocol-mcp:dexpaprika-mcp.getNetworkDexes.solana"];
  assert.equal(dex.assert({ content: [{ type: "text", text: JSON.stringify({ dexes: [{ chain: "solana", dex_id: "orca" }] }) }] }), null);
  assert.ok(dex.assert({ content: [{ type: "text", text: JSON.stringify({ dexes: [] }) }] }));
  const tm = byId["agentkit-provider:truemarkets.get_prediction_markets"];
  assert.equal(tm.assert(JSON.stringify({ success: true, totalMarkets: 3, markets: [{ id: 1 }] })), null);
  assert.ok(tm.assert(JSON.stringify({ success: false })));
});

test("buildRecord carries the chain", () => {
  const a = byId["protocol-mcp:dexpaprika-mcp.getNetworkDexes.solana"];
  const r = buildRecord(a, SOURCES[a.source], { version: "2.5.1", call: { ok: false, step: "call", error: "x" }, custody: { result: "not_run", answers: null, check_url: null } });
  assert.equal(r.chain, "solana");
});
