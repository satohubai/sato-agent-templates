// The weekly Base Sepolia lane: RPC choice, cell discovery and the workflow's shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chainIdOf, pickRpc, BASE_SEPOLIA_CHAIN_ID } from "./testnet-rpc.mjs";
import { discoverCells, cellsWithScript, hasScript, matrixFor, expectList, LANES } from "./discover-templates.mjs";
import { applyResults, badgesFor } from "./update-status.mjs";

test("chainIdOf reads a hex eth_chainId answer and nothing else", () => {
  assert.equal(chainIdOf({ result: "0x14a34" }), BASE_SEPOLIA_CHAIN_ID);
  assert.equal(chainIdOf({ result: "0x2105" }), 8453);
  assert.equal(chainIdOf({ error: { code: -32000 } }), null);
  assert.equal(chainIdOf({ result: "84532" }), null);
  assert.equal(chainIdOf(null), null);
});

test("pickRpc takes the first candidate that answers Base Sepolia and falls back past failures", async () => {
  const answers = {
    "https://down.example": () => { throw new Error("fetch failed"); },
    "https://mainnet.example": () => ({ result: "0x2105" }),
    "https://sepolia.example": () => ({ result: "0x14a34" }),
    "https://later.example": () => ({ result: "0x14a34" }),
  };
  const seen = [];
  const r = await pickRpc(Object.keys(answers), async (u) => { seen.push(u); return answers[u](); });
  assert.equal(r.url, "https://sepolia.example");
  assert.deepEqual(seen, ["https://down.example", "https://mainnet.example", "https://sepolia.example"]);
  assert.deepEqual(r.tried.map((t) => t.ok), [false, false, true]);
  assert.match(r.tried[1].reason, /chain id 8453/);
});

test("pickRpc returns null when nothing answers, and never probes a non-https URL", async () => {
  let probed = 0;
  const r = await pickRpc(["http://plain.example", "https://bad.example"], async () => { probed++; return { result: "0x1" }; });
  assert.equal(r.url, null);
  assert.equal(probed, 1);
  assert.equal(r.tried[0].reason, "not an https URL");
});

test("hasScript needs a non-empty string script", () => {
  assert.equal(hasScript({ scripts: { "testnet-check": "tsx scripts/testnet-check.ts" } }, "testnet-check"), true);
  assert.equal(hasScript({ scripts: { "testnet-check": " " } }, "testnet-check"), false);
  assert.equal(hasScript({ scripts: {} }, "testnet-check"), false);
  assert.equal(hasScript({}, "testnet-check"), false);
  assert.equal(hasScript(null, "testnet-check"), false);
});

test("the testnet lane covers exactly the templates that define testnet-check", () => {
  assert.ok(LANES.includes("testnet"));
  const all = discoverCells(".");
  const withCheck = cellsWithScript(all, "testnet-check", ".");
  for (const c of all) {
    const pkg = JSON.parse(readFileSync(`templates/${c.template}/${c.framework}/package.json`, "utf8"));
    assert.equal(withCheck.some((x) => x.template === c.template && x.framework === c.framework), hasScript(pkg, "testnet-check"), `${c.template}/${c.framework}`);
  }
  // Every base-guarded-trader variant, treasury-monitor and x402-seller carry one.
  for (const c of all.filter((x) => ["base-guarded-trader", "treasury-monitor", "x402-seller"].includes(x.template))) {
    assert.ok(withCheck.some((x) => x.template === c.template && x.framework === c.framework), `${c.template}/${c.framework} has no testnet-check`);
  }
  const m = matrixFor(withCheck, ["testnet"]);
  assert.ok(m.include.every((c) => c.lane === "testnet"));
  assert.match(expectList(m), /^([a-z0-9-]+\/[a-z0-9-]+\/testnet,?)+$/);
});

test("each testnet-check is keyless and never broadcasts", () => {
  for (const c of cellsWithScript(discoverCells("."), "testnet-check", ".")) {
    const src = readFileSync(`templates/${c.template}/${c.framework}/scripts/testnet-check.ts`, "utf8");
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
    assert.doesNotMatch(code, /sendTransaction|sendRawTransaction|writeContract|\.execute\(|privateKey|PRIVATE_KEY|CDP_|mnemonic/i, `${c.template}/${c.framework}`);
    assert.match(code, /BASE_SEPOLIA_RPC_URL/);
  }
});

test("testnet results fold into status.json beside the nightly cells without touching them or the badges", () => {
  const prev = applyResults({ cells: [] }, [{ template: "t", framework: "f", lane: "pinned", result: "green" }], { date: "2026-09-27" });
  const next = applyResults(prev, [{ template: "t", framework: "f", lane: "testnet", result: "red", failing_step: "testnet_check" }], {
    date: "2026-09-28",
    expected: ["t/f/testnet", "t/g/testnet"],
  });
  const byId = Object.fromEntries(next.cells.map((c) => [`${c.template}/${c.framework}/${c.lane}`, c]));
  assert.equal(byId["t/f/pinned"].last_run, "2026-09-27");
  assert.equal(byId["t/f/testnet"].result, "red");
  assert.equal(byId["t/g/testnet"].failing_step, "no_result");
  assert.deepEqual(Object.keys(badgesFor(next)), ["t-f.json"]);
});

test("testnet.yml: weekly + dispatch, pinned actions, read-only jobs, status-branch writes only", () => {
  const t = readFileSync(".github/workflows/testnet.yml", "utf8");
  assert.match(t, /schedule:\n\s+- cron: "[^"]+"/);
  assert.match(t, /workflow_dispatch:/);
  assert.match(t, /^permissions:\n\s+contents: read$/m);
  for (const m of t.matchAll(/uses:\s*(\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, `unpinned: ${m[1]}`);
  assert.match(t, /--lanes testnet --script testnet-check/);
  assert.match(t, /npm run testnet-check/);
  assert.match(t, /pull --rebase origin status && git push origin HEAD:status/);
  assert.match(t, /--status status-data\/status\.json/);
  assert.doesNotMatch(t, /secrets\./, "the lane is keyless: no secret is read");
  assert.doesNotMatch(t, /anvil|foundry/);
});
