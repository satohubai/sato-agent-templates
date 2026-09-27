// The custody cell: Sato Check's three answers for an action's source, as the
// public GET /api/check returned them. Nothing is inferred: "unknown" stays
// "unknown", and a check that could not be read is "not_run".

export const CHECK_API = "https://satohub.ai/api/check";
export const USER_AGENT = "SatoHub-templates-ci/1.0";

export function checkUrlFor(target, kind) {
  return `${CHECK_API}?target=${encodeURIComponent(target)}&kind=${encodeURIComponent(kind)}`;
}

/** Pure: a /api/check response body → the frozen custody cell. */
export function custodyCell(body) {
  const p = body?.profile;
  if (!p || typeof p !== "object") return { result: "not_run", answers: null, check_url: null };
  const str = (v) => (typeof v === "string" && v ? v : "unknown");
  const answers = { takes_key: str(p.key_access), key_leaves: str(p.key_egress), moves_funds: str(p.fund_actions) };
  const answered = Object.values(answers).some((v) => v !== "unknown");
  return {
    result: answered ? "answered" : "unknown",
    answers,
    check_url: typeof body.check_url === "string" ? body.check_url : null,
  };
}

/** One GET per (kind, target), time-boxed. fetchImpl is injected in tests. */
export async function fetchCustody(target, kind, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  try {
    const res = await fetchImpl(checkUrlFor(target, kind), {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { result: "not_run", answers: null, check_url: null, detail: `HTTP ${res.status}` };
    return custodyCell(await res.json());
  } catch (e) {
    return { result: "not_run", answers: null, check_url: null, detail: String(e?.message ?? e).slice(0, 200) };
  }
}
