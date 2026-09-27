import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTIONS, BASE_BLOCK_HASH, FORK_BLOCK, PYTH_ETH_USD, SOURCES, formatUnits, thirdParty } from "./actions-catalog.mjs";
import { buildRecord, expectedValue, sha256 } from "./check-actions.mjs";
import { custodyCell, fetchCustody, checkUrlFor } from "./lib/custody.mjs";
import { lintSkill, lintTool, schemaLintCell } from "./lib/host-lint.mjs";
import { lintDescription, lintPortableSchema } from "./lib/oda-lint.mjs";
import { parseFrontmatter, skillConformance } from "./lib/skill.mjs";
import { bareEnv } from "./lib/stdio-mcp.mjs";

const byId = Object.fromEntries(ACTIONS.map((a) => [a.id, a]));

test("catalog: at least ten third-party actions, unique ids, every source known", () => {
  assert.ok(thirdParty().length >= 10);
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
