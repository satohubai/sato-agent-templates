import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCharacter, parseCharacter, systemPrompt } from "../src/character.js";

test("character.json is valid and becomes a system prompt with memories", () => {
  const c = loadCharacter("character.json");
  const p = systemPrompt(c, ["ada: likes short answers"]);
  assert.match(p, new RegExp(`You are ${c.name}`));
  assert.match(p, /ada: likes short answers/);
  assert.match(p, /cannot sign or send/);
});

test("a malformed character is rejected with the field named", () => {
  assert.throws(() => parseCharacter({ schema: "persona-agent.character/v1", name: "" }), /name/);
});
