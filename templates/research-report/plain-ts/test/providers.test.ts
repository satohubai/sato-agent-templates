import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeAdapter, realAdapter } from "../src/providers.js";

const UA = "sato-template/research-report@0.1.0";

test("no key is a typed refusal, not a substitution", () => {
  const r = realAdapter({ env: {}, userAgent: UA });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason_code, "provider_key_missing");
});

test("a model outside the candidates is refused", () => {
  const r = realAdapter({ env: { ANTHROPIC_API_KEY: "test-not-a-key" }, model: "anthropic/other", userAgent: UA });
  assert.equal(!r.ok && r.reason_code, "model_not_a_candidate");
});

test("the real adapter sends the template user-agent and the candidate's API id (injected fetch, no network)", async () => {
  let seen: { url: string; headers: Record<string, string>; body: { model: string } } | null = null;
  const fetchStub = (async (url: string, init: RequestInit) => {
    seen = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
    return new Response(JSON.stringify({ content: [{ type: "text", text: "{}" }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = realAdapter({ env: { ANTHROPIC_API_KEY: "test-not-a-key" }, userAgent: UA, fetch: fetchStub });
  assert.ok(r.ok);
  if (!r.ok) return;
  const c = await r.adapter.complete({ system: "s", prompt: "p", max_tokens: 10 });
  assert.equal(c.text, "{}");
  assert.equal(seen!.url, "https://api.anthropic.com/v1/messages");
  assert.equal(seen!.headers["user-agent"], UA);
  assert.equal(seen!.body.model, "claude-sonnet-5");
});

test("the fake adapter replays text and labels itself fake", async () => {
  const c = await fakeAdapter({ findings: [] }).complete({ system: "", prompt: "", max_tokens: 1 });
  assert.equal(c.provider, "fake");
  assert.equal(c.text, '{"findings":[]}');
});
