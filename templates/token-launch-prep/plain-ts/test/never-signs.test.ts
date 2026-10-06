// This template prepares and simulates; it never signs or sends. These tests
// check that in three ways: no signing or sending call exists in the code, the
// kit it builds has no signer and no action that can write, and the offline
// RPC answers nothing that would send.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient } from "viem";
import { base } from "viem/chains";
import { fixtureTransport, loadRpcFixtures } from "../src/fixtures.js";
import { loadPolicy } from "../src/policy.js";
import { buildRuntime, kitFor } from "../src/runtime.js";

const SIGN_OR_SEND =
  /sendTransaction|sendRawTransaction|writeContract|signTransaction|signMessage|signTypedData|signAuthorization|privateKeyToAccount|mnemonicToAccount|hdKeyToAccount|createWalletClient|walletActions|\.execute\(|\.prepare\(|PRIVATE_KEY|privateKey|Signer\(|signer\s*:/;

/** Code only: comment lines are dropped, so a comment that names a forbidden call to explain its absence is not a hit. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .map((l) => l.replace(/\s\/\/.*$/, ""))
    .join("\n");
}

const sourceFiles = [...readdirSync("src").map((f) => join("src", f)), ...readdirSync("scripts").map((f) => join("scripts", f))].filter((f) => f.endsWith(".ts"));

test("no source file signs, sends, or reads a key", () => {
  assert.ok(sourceFiles.length >= 8, sourceFiles.join(", "));
  for (const f of sourceFiles) {
    const m = code(f).match(SIGN_OR_SEND);
    assert.equal(m, null, `${f}: ${m?.[0]}`);
  }
});

test("no npm script and no environment name carries a key or a broadcast step", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  for (const [name, cmd] of Object.entries(pkg.scripts as Record<string, string>)) assert.doesNotMatch(`${name} ${cmd}`, /broadcast|send|deploy|sign/i, name);
  const tpl = JSON.parse(readFileSync("sato.template.json", "utf8"));
  for (const n of tpl.declared_secret_names as string[]) assert.doesNotMatch(n, /KEY|SECRET|MNEMONIC|SEED|PRIVY|CDP|SIGNER/, n);
  assert.doesNotMatch(readFileSync(".env.example", "utf8").replace(/^#.*$/gm, ""), /KEY|SECRET|MNEMONIC|SEED|PRIVY|CDP|SIGNER/);
});

test("the kit is built with no signer and one passive action, tx.simulate", async () => {
  const rt = await buildRuntime({ mode: "fixture", policy: loadPolicy("policy.json"), fixturesDir: "fixtures", env: {} });
  const all = rt.kit.search("");
  assert.deepEqual(all.map((d) => d.id), ["tx.simulate"]);
  assert.deepEqual(rt.kit.describe("tx.simulate").effects, ["simulate"]);
  assert.equal(rt.kit.describe("tx.simulate").custody.moves_funds, "never");
  // Nothing can be prepared, so nothing can ever be executed.
  await assert.rejects(rt.kit.prepare("tx.simulate", {}));
  await assert.rejects(rt.kit.execute({ intent_id: "0x" + "00".repeat(32) } as never));
  // The source builds the kit in one place, with no signer option.
  const runtime = code("src/runtime.ts");
  assert.equal((runtime.match(/createKit\(/g) ?? []).length, 1);
  assert.doesNotMatch(runtime, /signer/i);
  assert.ok(kitFor);
});

test("the offline RPC holds no send and refuses any unrecorded call, sends included", async () => {
  const fixtures = loadRpcFixtures("fixtures");
  for (const k of Object.keys(fixtures)) assert.match(k, /^(eth_chainId|eth_blockNumber|eth_call |eth_estimateGas )/, k);
  const client = createPublicClient({ chain: base, transport: fixtureTransport(fixtures) });
  await assert.rejects(client.request({ method: "eth_sendRawTransaction", params: ["0x02"] } as never), /no recorded RPC answer/);
  await assert.rejects(client.request({ method: "eth_sendTransaction", params: [{}] } as never), /no recorded RPC answer/);
});
