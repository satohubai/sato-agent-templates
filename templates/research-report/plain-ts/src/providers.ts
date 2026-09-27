// The two model providers this template can hold.
//
// FAKE replays a response a scenario carries. The task's real code path runs,
// including the parse and the whole gate, over text the scenario chose — which
// is how a scenario proves the gate rejects a fabrication.
//
// REAL calls Anthropic's Messages API over fetch, only with ANTHROPIC_API_KEY
// set by you, and only for a model among the candidates. A missing key or a
// model that is not a candidate is a typed refusal, never a substitution.
//
// `evaluated` is EMPTY: the candidates are configured choices. No model has
// been evaluated against this template. Identifiers read from
// https://platform.claude.com/docs/en/about-claude/models/overview on
// 2026-09-20 (carried over from the recipe); re-read that page before relying
// on them.

export const MODEL_POLICY = {
  recommended: "anthropic/claude-sonnet-5",
  candidates: ["anthropic/claude-sonnet-5", "anthropic/claude-haiku-4-5"],
  evaluated: [] as string[],
} as const;

export type CompletionRequest = { system: string; prompt: string; max_tokens: number; temperature?: number };
export type Completion = { text: string; model: string; provider: string };
export type ModelAdapter = { id: string; provider: string; complete(req: CompletionRequest): Promise<Completion> };

export function fakeAdapter(response: unknown): ModelAdapter {
  return {
    id: "fake/fixture-replay",
    provider: "fake",
    async complete() {
      return { text: typeof response === "string" ? response : JSON.stringify(response ?? {}), model: "fake/fixture-replay", provider: "fake" };
    },
  };
}

export type AdapterResult = { ok: true; adapter: ModelAdapter } | { ok: false; reason_code: "provider_key_missing" | "model_not_a_candidate"; detail: string };

export function realAdapter(opts: { model?: string; env: NodeJS.ProcessEnv; fetch?: typeof fetch; userAgent: string }): AdapterResult {
  const key = opts.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return { ok: false, reason_code: "provider_key_missing", detail: "ANTHROPIC_API_KEY is not set; this is a missing prerequisite, not a reason to use a different provider" };
  const requested = opts.model ?? MODEL_POLICY.recommended;
  if (!(MODEL_POLICY.candidates as readonly string[]).includes(requested)) {
    return { ok: false, reason_code: "model_not_a_candidate", detail: `${requested} is not among this template's candidates (${MODEL_POLICY.candidates.join(", ")})` };
  }
  const apiId = requested.replace(/^anthropic\//, "");
  const doFetch = opts.fetch ?? globalThis.fetch;
  return {
    ok: true,
    adapter: {
      id: requested,
      provider: "anthropic",
      async complete(req) {
        const res = await doFetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "user-agent": opts.userAgent },
          body: JSON.stringify({ model: apiId, max_tokens: req.max_tokens, temperature: req.temperature ?? 0, system: req.system, messages: [{ role: "user", content: req.prompt }] }),
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) throw new Error(`anthropic responded ${res.status}`);
        const json = (await res.json()) as { content?: { type: string; text?: string }[] };
        return { text: (json.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join(""), model: apiId, provider: "anthropic" };
      },
    },
  };
}
