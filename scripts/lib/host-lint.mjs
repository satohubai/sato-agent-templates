// Host-specific facts about one tool, on top of the portable lint
// (./oda-lint.mjs). Each finding says what a host does with the tool as it is
// published; none is a judgement of the tool. Pure and dependency-free.
//
//   openai  function names are [A-Za-z0-9_-]{1,64} (no dots); parameters is a
//           JSON Schema object and strict mode refuses a combinator at its root
//   cursor  the client loads a bounded number of tools across all servers
//   claude  tool names are [A-Za-z0-9_-]{1,64}; input_schema is an object;
//           Claude Code truncates an MCP tool description past 2048 characters

import { lintDescription, lintPortableSchema } from "./oda-lint.mjs";

export const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const CURSOR_TOOL_BUDGET = 40;
export const CLAUDE_DESCRIPTION_MAX = 2048;
export const CLAUDE_SKILL_DESCRIPTION_MAX = 1024;

const ROOT_COMBINATORS = ["oneOf", "anyOf", "allOf", "not"];

function isObj(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function rootFacts(schema, host) {
  const out = [];
  if (!isObj(schema) || schema.type !== "object") out.push({ rule: "root_not_object", message: `${host} expects the input schema to be a JSON Schema object` });
  if (isObj(schema)) for (const c of ROOT_COMBINATORS) if (c in schema) out.push({ rule: "root_combinator", message: `${c} at the input schema root` });
  return out;
}

/**
 * tool: { name, description?, inputSchema?, outputSchema? }
 * ctx:  { serverToolCount?: number }  — how many tools the same server lists
 * → { portable: Issue[], hosts: { openai: Fact[], cursor: Fact[], claude: Fact[] } }
 */
export function lintTool(tool, ctx = {}) {
  const portable = [];
  if (tool.inputSchema !== undefined) portable.push(...lintPortableSchema(tool.inputSchema, "input_schema"));
  if (tool.outputSchema !== undefined && tool.outputSchema !== null) portable.push(...lintPortableSchema(tool.outputSchema, "output_schema"));
  if (typeof tool.description === "string") portable.push(...lintDescription(tool.description));

  const openai = [];
  if (!TOOL_NAME_RE.test(tool.name ?? "")) openai.push({ rule: "name_charset", message: "the name has a character outside [A-Za-z0-9_-] or is longer than 64 characters" });
  if (tool.inputSchema !== undefined) openai.push(...rootFacts(tool.inputSchema, "OpenAI"));

  const cursor = [];
  if (typeof ctx.serverToolCount === "number" && ctx.serverToolCount > CURSOR_TOOL_BUDGET) {
    cursor.push({ rule: "tool_budget", message: `the server lists more tools than Cursor's ${CURSOR_TOOL_BUDGET}-tool budget; some may not load` });
  }

  const claude = [];
  if (!TOOL_NAME_RE.test(tool.name ?? "")) claude.push({ rule: "name_charset", message: "the name has a character outside [A-Za-z0-9_-] or is longer than 64 characters" });
  if (tool.inputSchema !== undefined) claude.push(...rootFacts(tool.inputSchema, "Claude"));
  if (typeof tool.description === "string" && tool.description.length > CLAUDE_DESCRIPTION_MAX) {
    claude.push({ rule: "description_too_long", message: `the description is longer than ${CLAUDE_DESCRIPTION_MAX} characters; Claude Code truncates it` });
  }
  return { portable, hosts: { openai, cursor, claude } };
}

/** A skill has no schemas: only its description is checked. */
export function lintSkill(skill) {
  const portable = typeof skill.description === "string" ? lintDescription(skill.description) : [];
  const claude = [];
  if (typeof skill.description === "string" && skill.description.length > CLAUDE_SKILL_DESCRIPTION_MAX) {
    claude.push({ rule: "skill_description_too_long", message: `the skill description is longer than ${CLAUDE_SKILL_DESCRIPTION_MAX} characters` });
  }
  return { portable, hosts: { openai: [], cursor: [], claude } };
}

/** The frozen schema_lint cell. Findings are reported, never a failure. */
export function schemaLintCell(lint) {
  if (!lint) return { result: "not_run", hosts: { openai: [], cursor: [], claude: [] }, portable: [] };
  const any = lint.portable.length + lint.hosts.openai.length + lint.hosts.cursor.length + lint.hosts.claude.length;
  return { result: any ? "findings" : "pass", hosts: lint.hosts, portable: lint.portable };
}
