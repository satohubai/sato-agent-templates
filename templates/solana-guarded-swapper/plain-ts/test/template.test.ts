import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const tpl = JSON.parse(readFileSync("sato.template.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));

test("package.json pins exact versions only", () => {
  for (const deps of [pkg.dependencies, pkg.devDependencies]) {
    for (const [name, v] of Object.entries(deps as Record<string, string>)) assert.ok(/^\d+\.\d+\.\d+$/.test(v), `${name}@${v}`);
  }
});

// The latest lane (SATO_LANE=latest) moves versions on purpose, so pin
// consistency is only meaningful on the pinned lane.
const PIN_CHECK_SKIP = process.env.SATO_LANE === "latest" ? "SATO_LANE=latest: the latest lane changes versions on purpose; pin consistency is checked on the pinned lane" : false;

test("sato.template.json upstream pins match the lockfile", { skip: PIN_CHECK_SKIP }, () => {
  for (const [name, v] of Object.entries(tpl.template.upstream as Record<string, string>)) assert.equal(lock.packages[`node_modules/${name}`]?.version, v, name);
});

// A repo made by create-sato-agent carries sato.create.json, and its policy.json holds the caps from the
// builder's goal; the template's defaults stay in sato.template.json.
const GENERATED = existsSync("sato.create.json") ? "generated repo: policy.json carries the caps from the goal; the defaults live in sato.template.json" : false;

test("sato.template.json policy_defaults match policy.json", { skip: GENERATED }, () => {
  const policy = JSON.parse(readFileSync("policy.json", "utf8"));
  for (const [k, v] of Object.entries(tpl.template.policy_defaults)) assert.deepEqual(policy[k], v, k);
});

test("the fixture command in the template is the one CI runs", () => {
  assert.deepEqual(tpl.harness.fixture_command, ["npm", "start", "--", "--mode", "fixture"]);
  assert.equal(tpl.network.test, "none");
});

test("the manifest: swap intent, Solana, fork by default, never mainnet by default", () => {
  assert.equal(tpl.id, "solana-guarded-swapper");
  assert.equal(tpl.template.framework, "plain-ts");
  assert.deepEqual(tpl.template.intents, ["trading", "swap"]);
  assert.deepEqual(tpl.template.chains, ["solana"]);
  assert.equal(tpl.template.default_network, "fork");
  assert.equal(tpl.template.policy_defaults.network, "fork");
  assert.deepEqual(tpl.template.networks, ["fork", "mainnet"]);
});

test("@solana/kit is pinned at 8 here and nowhere in the lock at another major", () => {
  assert.equal(pkg.dependencies["@solana/kit"], "8.4.0");
  for (const [path, e] of Object.entries(lock.packages as Record<string, { version?: string }>)) {
    if (/^node_modules\/@solana\/(kit|addresses|keys|rpc|signers|transactions)$/.test(path)) assert.match(e.version ?? "", /^8\./, path);
  }
});

// ── no signer, no key ────────────────────────────────────────────────────────

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.(ts|mjs)$/.test(f) ? [p] : [];
  });
}

test("src/ and scripts/ hold no signing or sending call, no key loader and no key material", () => {
  const forbidden = [
    /\bsendTransaction\b/,
    /\bsendSolanaTransaction\b/,
    /\bsignSolanaTransaction\b/,
    /\bsendSignedSolanaTx\b/,
    /\bsignTransaction/i,
    /\bpartiallySignTransaction\b/,
    /\bsolanaLocalSigner\b/,
    /\bcreateKeyPairSigner/,
    /\bgenerateKeyPair/,
    /\bcreateSignerFromKeyPair/,
    /\bexecute\s*\(/,
    /\bviemLocalSigner\b|\bcdpSigner\b|\bowsSigner\b/,
    /privateKey|secretKey|PRIVATE_KEY|SECRET_KEY|keypair\.json|id\.json|mnemonic/,
  ];
  const dirs = ["src", "scripts"].filter((d) => {
    try {
      return statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
  const hits: string[] = [];
  for (const d of dirs) {
    for (const f of sourceFiles(d)) {
      // config.ts names key-shaped words only to REFUSE them.
      if (f.endsWith("config.ts")) continue;
      const text = readFileSync(f, "utf8").replace(/\/\/.*$/gm, "");
      for (const re of forbidden) if (re.test(text)) hits.push(`${f}: ${re}`);
    }
  }
  assert.deepEqual(hits, []);
});

test("the RPC methods the template can send are read methods and simulateTransaction", () => {
  const sent = new Set<string>();
  for (const f of sourceFiles("src")) for (const m of readFileSync(f, "utf8").matchAll(/(?:rpc|request)\(\s*"([A-Za-z]+)"/g)) sent.add(m[1]);
  // The kit's own simulateTransaction and the preflight's getMultipleAccounts are the only RPC methods named in this template's source.
  for (const m of sent) assert.ok(["getMultipleAccounts", "simulateTransaction", "getBalance"].includes(m), m);
});

test(".env.example names variables only and none is a key", () => {
  const lines = readFileSync(".env.example", "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l));
  assert.ok(lines.length > 0);
  for (const l of lines) {
    assert.match(l, /^[A-Z_]+=$/, "a name with no value");
    assert.doesNotMatch(l, /KEY|SECRET|MNEMONIC|SEED|PASSPHRASE/, l);
  }
  assert.deepEqual(tpl.declared_secret_names.sort(), lines.map((l) => l.slice(0, -1)).sort());
});

// ── wording ──────────────────────────────────────────────────────────────────

test("plain, descriptive wording: no claims the template cannot back", () => {
  const banned = /\b(best|safe|safer|safest|secure|audited|trusted|trustworthy|verified|passed|malicious|scam|rug-?free|profit(s|able)?|guaranteed|risk-free|investment opportunity|moon|10x|returns?)\b/i;
  // AGENTS.md is not scanned: it lists the words an agent must not write.
  for (const f of ["sato.template.json", "README.md", "package.json", "receipts.config.json", "config.json", "schemas/input.json", "schemas/output.json", "LICENSE-ATTRIBUTION.md"]) {
    // A generated repo's README carries create-sato-agent's own sections after a
    // "---" rule (they name a Safe wallet module); only this template's text is checked.
    const text = readFileSync(f, "utf8")
      .split(/\n---\n+## Generated by create-sato-agent/)[0]
      // Allowed only in the negations this template states about itself.
      .replace(/not a safety rating, an audit/g, "")
      .replace(/not a security review/gi, "")
      .replace(/not audited/gi, "");
    const m = text.match(banned);
    assert.equal(m, null, `${f}: "${m?.[0]}"`);
  }
});

test("the README states the limits it must", () => {
  const readme = readFileSync("README.md", "utf8");
  assert.match(readme, /It has no signer and holds no key/);
  assert.match(readme, /A quote is not a fill/i);
  assert.match(readme, /receipts\.config\.json/);
  assert.match(readme, /ships with `credential` and `receipt_schema` set to `null`/);
  assert.match(readme, /exits \*\*0 unless you pass `--strict`\*\*/);
  assert.match(readme, /--accept-mainnet-risk/);
});
