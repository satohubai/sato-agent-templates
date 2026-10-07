// The Sato OS hand-off, end to end against a fake Sato OS on 127.0.0.1:
// attach stores the token; --mode sato-os files every ALLOWED intent as a
// proposal and never sends the refused one. Offline: --data fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { PreparedIntent } from "@satohub/kit";
import { parseArgs, UsageError } from "../src/config.js";
import { AttachUsageError, handOff, parseAttachArgs, runAttach, SATO_OS_AGENT_FILE } from "../src/sato-os.js";
import { FIXTURE_CLOCK_MS, FIXTURE_TAKER } from "../src/runtime.js";
import { recordingsPolicy } from "./goal-bound.js";

const TOKEN = "sos_test_token_not_a_real_secret";

type Seen = { attach: Record<string, unknown>[]; proposals: { auth: string | undefined; args: Record<string, unknown> }[] };

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = "";
  for await (const c of req) s += c;
  return JSON.parse(s || "{}");
}

async function fakeSatoOs(): Promise<{ url: string; seen: Seen; server: Server }> {
  const seen: Seen = { attach: [], proposals: [] };
  const server = createServer(async (req, res) => {
    const b = await body(req);
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/api/os/agents/attach") {
      seen.attach.push(b);
      res.statusCode = 201;
      res.end(JSON.stringify({ ok: true, data: { agent: { id: "agt_test", slug: "base-guarded-trader", open_at: "/os/agents/agt_test" }, wallets: [], passportImported: false, apiToken: TOKEN, mcpEndpoint: "/api/os/mcp" } }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/os/mcp") {
      const params = b.params as { name: string; arguments: Record<string, unknown> };
      seen.proposals.push({ auth: req.headers.authorization, args: params.arguments });
      const n = seen.proposals.length;
      res.end(JSON.stringify({ jsonrpc: "2.0", id: b.id, result: { content: [{ type: "text", text: "ok" }], structuredContent: { intentId: `int_${n}`, approvalId: `apr_${n}`, status: "pending_approval", tier: "approval", policy: {} } } }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, server };
}

function run(args: string[]): Promise<{ code: number | null; text: string }> {
  return new Promise((resolve) => {
    const p = spawn("npm", ["start", "--silent", "--", ...args], { env: { ...process.env, ANVIL_RPC_URL: "", SATO_OS_WALLET: "", BASE_RPC_URL: "" } });
    let text = "";
    p.stdout.on("data", (d) => (text += d));
    p.stderr.on("data", (d) => (text += d));
    const t = setTimeout(() => p.kill("SIGKILL"), 120_000);
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, text });
    });
  });
}

test("--mode sato-os is a mode; --data only goes with it", () => {
  assert.equal(parseArgs(["--mode", "sato-os"]).mode, "sato-os");
  assert.equal(parseArgs(["--mode", "sato-os"]).data, "live");
  assert.equal(parseArgs(["--mode", "sato-os", "--data", "fixture"]).data, "fixture");
  assert.throws(() => parseArgs(["--mode", "fixture", "--data", "fixture"]), UsageError);
  assert.throws(() => parseArgs(["--mode", "sato-os", "--execute"]), UsageError);
});

test("sato-os:attach needs a URL and a wallet address, never a key", () => {
  assert.throws(() => parseAttachArgs([], {}), AttachUsageError);
  assert.throws(() => parseAttachArgs(["--url", "https://os.example"], {}), /wallet/);
  assert.throws(() => parseAttachArgs(["--url", "https://os.example", "--wallet", "0x" + "ab".repeat(32)], {}), /wallet/);
  const a = parseAttachArgs([], { SATO_OS_URL: "https://os.example", SATO_OS_WALLET: FIXTURE_TAKER });
  assert.equal(a.url, "https://os.example");
  assert.deepEqual(a.chains, ["Base"]);
});

test("--mode sato-os refuses to start before an attach", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bgt-sos-none-"));
  const r = await run(["--mode", "sato-os", "--data", "fixture", "--sato-dir", join(dir, ".sato"), "--out", join(dir, "out")]);
  assert.notEqual(r.code, 0, r.text);
  assert.match(r.text, /attach first/);
});

test("attach stores the token; sato-os mode proposes the allowed intent and never the refused one", async () => {
  const { url, seen, server } = await fakeSatoOs();
  try {
    const dir = mkdtempSync(join(tmpdir(), "bgt-sos-"));
    const satoDir = join(dir, ".sato");
    const res = await runAttach(parseAttachArgs(["--url", url, "--wallet", FIXTURE_TAKER, "--dir", satoDir], {}));
    assert.equal(res.agent_id, "agt_test");
    assert.equal(seen.attach.length, 1);
    assert.equal(seen.attach[0].issueToken, true);
    assert.deepEqual(seen.attach[0].walletAddresses, [FIXTURE_TAKER]);
    const cfgPath = join(satoDir, "sato-os.json");
    assert.equal(JSON.parse(readFileSync(cfgPath, "utf8")).token, TOKEN);
    assert.equal(statSync(cfgPath).mode & 0o777, 0o600);
    assert.match(readFileSync(join(satoDir, ".gitignore"), "utf8"), /sato-os\.json/);
    assert.ok(existsSync(join(satoDir, SATO_OS_AGENT_FILE)));

    const out = join(dir, "out");
    const r = await run(["--mode", "sato-os", "--data", "fixture", "--sato-dir", satoDir, "--out", out, "--policy", recordingsPolicy()]);
    assert.equal(r.code, 0, r.text);
    assert.ok(!r.text.includes(TOKEN), "the token is never printed");
    assert.match(r.text, /REFUSED rule=max_usd_per_trade/);

    const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
    assert.equal(report.mode, "sato-os");
    assert.equal(report.executed, false);
    const allowed = report.intents.filter((i: { policy_ok: boolean }) => i.policy_ok).map((i: { intent_id: string }) => i.intent_id);
    const refused = report.intents.filter((i: { policy_ok: boolean }) => !i.policy_ok).map((i: { intent_id: string }) => i.intent_id);
    assert.ok(allowed.length >= 1, "the agent's own intent passes the pre-flight on the recordings");
    assert.ok(refused.length >= 1, "the over-cap demo intent is refused");

    // Exactly the allowed intents reached Sato OS, with the stored token.
    assert.equal(seen.proposals.length, allowed.length);
    for (const p of seen.proposals) {
      assert.equal(p.auth, `Bearer ${TOKEN}`);
      assert.equal(p.args.agentId, "agt_test");
      const kit = p.args.satoKitIntent as PreparedIntent;
      assert.ok(allowed.includes(kit.intent_id));
      assert.ok(!refused.includes(kit.intent_id));
      assert.equal(kit.policy.ok, true);
    }
    for (const s of report.sato_os) {
      if (refused.includes(s.intent_id)) {
        assert.equal(s.proposed, false);
        assert.match(s.reason, /never proposed/);
      } else {
        assert.equal(s.proposed, true);
        assert.equal(s.status, "pending_approval");
      }
    }
  } finally {
    server.close();
  }
});

test("handOff makes no request at all for a refused intent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bgt-sos-ref-"));
  let calls = 0;
  const fake = (async () => {
    calls++;
    return new Response(JSON.stringify({ ok: true, data: { agent: { id: "agt_x" }, apiToken: TOKEN } }), { status: 201 });
  }) as typeof fetch;
  await runAttach(parseAttachArgs(["--url", "http://127.0.0.1:9", "--wallet", FIXTURE_TAKER, "--dir", dir], {}), fake);
  calls = 0;
  const refused = {
    intent_id: "sato:int:refused",
    policy: { ok: false, refusals: [{ rule: "max_usd_per_trade", limit: "25", observed: "1000", message: "over cap" }] },
    expires_at: new Date(FIXTURE_CLOCK_MS + 60_000).toISOString(),
  } as unknown as PreparedIntent;
  const out = await handOff([{ label: "over cap", intent: refused }], { dir, clock: () => FIXTURE_CLOCK_MS, fetch: fake });
  assert.equal(calls, 0);
  assert.equal(out[0].proposed, false);
  assert.match(out[0].reason ?? "", /max_usd_per_trade/);
});
