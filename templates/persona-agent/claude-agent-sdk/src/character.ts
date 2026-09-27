// character.json: who the agent is. Loaded once, validated, and turned into
// the system prompt the model sees. No field here grants any permission; the
// wallet's limits live in policy.json and the signer.

import { readFileSync } from "node:fs";

export type Character = {
  schema: "persona-agent.character/v1";
  name: string;
  bio: string[];
  style: { tone: string; rules: string[] };
  topics: string[];
  example_replies: { message: string; reply: string }[];
};

export function parseCharacter(raw: unknown): Character {
  const c = raw as Partial<Character>;
  const errs: string[] = [];
  if (!c || typeof c !== "object") throw new Error("character.json: not an object");
  if (c.schema !== "persona-agent.character/v1") errs.push('schema must be "persona-agent.character/v1"');
  if (typeof c.name !== "string" || !c.name.trim()) errs.push("name must be a non-empty string");
  if (!Array.isArray(c.bio) || c.bio.some((b) => typeof b !== "string")) errs.push("bio must be a list of strings");
  if (!c.style || typeof c.style.tone !== "string" || !Array.isArray(c.style.rules)) errs.push("style needs tone (string) and rules (list)");
  if (!Array.isArray(c.topics)) errs.push("topics must be a list");
  if (!Array.isArray(c.example_replies) || c.example_replies.some((e) => typeof e?.message !== "string" || typeof e?.reply !== "string")) errs.push("example_replies must be a list of { message, reply }");
  if (errs.length) throw new Error(`character.json: ${errs.join("; ")}`);
  return c as Character;
}

export function loadCharacter(path: string): Character {
  return parseCharacter(JSON.parse(readFileSync(path, "utf8")));
}

export function systemPrompt(c: Character, memories: string[]): string {
  return [
    `You are ${c.name}.`,
    ...c.bio,
    `Tone: ${c.style.tone}.`,
    "Rules:",
    ...c.style.rules.map((r) => `- ${r}`),
    `Topics you know: ${c.topics.join(", ")}.`,
    "Example replies:",
    ...c.example_replies.map((e) => `- "${e.message}" -> "${e.reply}"`),
    "Wallet: you may call wallet_quote and wallet_prepare. You cannot sign or send; a person approves any signature outside this conversation. When wallet_prepare returns refusals, quote each rule, limit and observed value.",
    memories.length ? "Things you remember about this conversation:" : "You remember nothing relevant yet.",
    ...memories.map((m) => `- ${m}`),
  ].join("\n");
}
