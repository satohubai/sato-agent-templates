// Policy checks that hold in this repo as shipped AND in a repo the Sato create
// engine generated from it.
//
// The engine writes a goal-bound policy.json: the template's policy_defaults
// with the user's caps laid over them and allow_tokens narrowed to the goal's
// pair. It also writes sato.create.json at the repo root, which is how a
// generated repo is told apart. A test that pins a default (a cap, the full
// token list) would fail the user's own repo, so those pins apply only when
// sato.create.json is absent. Everything the goal may not touch is checked in
// both: the refusing unknown_verdict, simulation, no mainnet, and a policy that
// can only narrow the shipped chain and token lists.
import { existsSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";

type Policy = Record<string, unknown>;

/** True in a repo the create engine generated (it always writes sato.create.json). */
export const GENERATED = existsSync("sato.create.json");

/** The keys a user's goal may change. Everything else must still equal the shipped default. */
const GOAL_BOUND = new Set(["network", "allow_chains", "allow_tokens", "max_usd_per_trade", "max_usd_per_day"]);

const lower = (xs: unknown): string[] => (Array.isArray(xs) ? xs.map((x) => String(x).toLowerCase()) : []);

/** The invariants a goal-bound policy.json must keep. Used for generated repos. */
export function assertGoalBoundPolicy(policy: Policy): void {
  const defaults = (JSON.parse(readFileSync("sato.template.json", "utf8")).template.policy_defaults ?? {}) as Policy;
  for (const [k, v] of Object.entries(defaults)) if (!GOAL_BOUND.has(k)) assert.deepEqual(policy[k], v, k);
  assert.equal(policy.unknown_verdict, "refuse");
  assert.equal(policy.require_simulation, true);
  assert.notEqual(policy.network, "mainnet");
  // The goal can narrow the shipped lists, never widen them.
  const chains = lower(defaults.allow_chains);
  for (const c of lower(policy.allow_chains)) assert.ok(chains.includes(c), `allow_chains ${c} is not in the template's list`);
  const tokens = lower(defaults.allow_tokens);
  if (tokens.length > 0) for (const t of lower(policy.allow_tokens)) assert.ok(tokens.includes(t), `allow_tokens ${t} is not in the template's list`);
  for (const k of ["max_usd_per_trade", "max_usd_per_day"]) assert.ok(typeof policy[k] === "number" && (policy[k] as number) > 0, `${k} must be a number above 0`);
}

/** policy.json equals the template's policy_defaults; in a generated repo, the goal-bound invariants instead. */
export function assertPolicyMatchesTemplate(policy: Policy): void {
  if (GENERATED) return assertGoalBoundPolicy(policy);
  const defaults = JSON.parse(readFileSync("sato.template.json", "utf8")).template.policy_defaults as Policy;
  for (const [k, v] of Object.entries(defaults)) assert.deepEqual(policy[k], v, k);
}
