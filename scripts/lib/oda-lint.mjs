// Vendored from Sato Hub app (private) lib/oda/lint.ts at
// 6084d1ab487983580cfc283e2040e642136d9c02, ported to plain JS (type
// annotations removed, nothing else changed). Edit there, then re-vendor.
// Only lintPortableSchema and lintDescription are vendored: the nightly checks
// third-party tools, which are not ODA descriptors, so lintActionDescriptor
// (and the names/types modules it imports) is left out.
/**
 * The portable-schema lint (scope §16.3) and the descriptor copy lint.
 *
 * WHY: one action schema has to load in every host — MCP clients, OpenAI
 * function calling, AI SDK, ADK, Cursor — and each loader rejects a different
 * corner of JSON Schema. The intersection is small: an object at the root, no
 * combinators there, no references, one type per node. Onchain values add
 * three rules of their own: amounts are decimal STRINGS (a uint256 does not fit
 * a JSON number), addresses are patterned strings, chains are enums. A schema
 * that passes here loads everywhere we have checked; one that fails is fixed
 * before it ships, not after a host silently drops the tool.
 *
 * The descriptor lint adds the copy rules: a description is stable text about
 * what the tool does. Dates, counts, prices and sponsorship change, and they
 * belong in structured output or _meta — never in the text a model reads to
 * pick a tool. Neither may a description claim the action is safe or best.
 *
 * Returns issues; never throws on a malformed schema (a lint reports).
 * Pure and dependency-free.
 */

export const DESCRIPTION_MAX = 1000;

const ROOT_COMBINATORS = ["oneOf", "anyOf", "allOf", "not"];
const SUBSCHEMA_LIST_KEYS = ["oneOf", "anyOf", "allOf", "prefixItems"];
const SUBSCHEMA_KEYS = ["items", "additionalProperties", "not", "if", "then", "else", "contains", "propertyNames"];

const AMOUNT_NAME = /^(amount|amount_.+|value|.+_wei|.+_base_units|uint256)$/;
const ADDRESS_NAME = /^(address|.+_address|to|from|token|recipient)$/;
const CHAIN_NAME = /^(chain|chain_id)$/;
/** A pattern that admits decimal digits. */
const DECIMALISH = /\[0-9\]|\\d/;

function isObj(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function lintPortableSchema(schema, path = "$") {
  const issues = [];
  if (!isObj(schema) || schema.type !== "object") {
    issues.push({ path, rule: "root_not_object", message: "the root must be a schema with type \"object\"" });
  }
  if (isObj(schema)) {
    for (const c of ROOT_COMBINATORS) {
      if (c in schema) issues.push({ path: `${path}.${c}`, rule: "root_combinator", message: `no ${c} at the root — several hosts reject it` });
    }
    walk(schema, path, issues);
  }
  return issues;
}

function walk(node, path, issues) {
  if ("$ref" in node) issues.push({ path: `${path}.$ref`, rule: "ref_forbidden", message: "no $ref — inline the schema" });
  for (const k of ["$defs", "definitions"]) {
    if (k in node) issues.push({ path: `${path}.${k}`, rule: "defs_forbidden", message: `no ${k} — inline the schema` });
  }
  if (Array.isArray(node.type)) {
    issues.push({ path: `${path}.type`, rule: "type_array", message: "one type per node — use a single type (make optional fields optional instead of nullable)" });
  }

  if (isObj(node.properties)) {
    for (const [name, sub] of Object.entries(node.properties)) {
      const p = `${path}.properties.${name}`;
      if (!isObj(sub)) continue;
      checkNamed(name, sub, p, issues);
      walk(sub, p, issues);
    }
  }
  for (const k of SUBSCHEMA_KEYS) {
    const sub = node[k];
    if (isObj(sub)) walk(sub, `${path}.${k}`, issues);
  }
  for (const k of SUBSCHEMA_LIST_KEYS) {
    const list = node[k];
    if (Array.isArray(list)) list.forEach((sub, i) => isObj(sub) && walk(sub, `${path}.${k}[${i}]`, issues));
  }
}

function checkNamed(name, s, path, issues) {
  const pattern = typeof s.pattern === "string" ? s.pattern : null;
  if (AMOUNT_NAME.test(name)) {
    if (s.type === "number" || s.type === "integer") {
      issues.push({ path, rule: "amount_not_string", message: `${name} is a ${s.type}; amounts and uint256 are decimal strings` });
    } else if (s.type === "string" && (!pattern || !DECIMALISH.test(pattern))) {
      issues.push({ path, rule: "amount_no_pattern", message: `${name} needs a decimal pattern, e.g. "^[0-9]{1,78}$"` });
    }
  }
  if (ADDRESS_NAME.test(name) && s.type !== "array" && s.type !== "object") {
    if (s.type !== "string" || !pattern) {
      issues.push({ path, rule: "address_not_patterned_string", message: `${name} must be a string with a pattern, e.g. "^0x[0-9a-fA-F]{40}$"` });
    }
  }
  if (CHAIN_NAME.test(name)) {
    if (!Array.isArray(s.enum) || s.enum.length === 0) {
      issues.push({ path, rule: "chain_not_enum", message: `${name} must be an enum of the chains the action supports` });
    }
  }
}

// ── description copy rules ───────────────────────────────────────────────────

const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const DATE_RES = [
  /\b\d{4}-\d{2}-\d{2}\b/,
  new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,4}\\b`),
  new RegExp(`\\b\\d{1,2}\\s+${MONTH}\\b`),
];
const COUNT_RES = [/\b\d{1,3}(?:,\d{3})+\b/, /\b\d+\+?\s+[A-Za-z]+s\b/];
const PRICE_RE = /\$|\bUSD\b|\bbps\b|%/i;
const SPONSOR_RE = /\b(?:sponsor(?:ed|s|ship)?|partner(?:s|ed|ship)?|paid)\b/i;
const CLAIM_RE = /\b(?:safe|safely|secure|securely|best|guaranteed?|guarantees)\b/i;

/** Copy issues for one description string. */
export function lintDescription(text, path = "description") {
  const issues = [];
  if (text.length > DESCRIPTION_MAX) issues.push({ path, rule: "description_too_long", message: `${text.length} characters; the limit is ${DESCRIPTION_MAX}` });
  if (DATE_RES.some((re) => re.test(text))) issues.push({ path, rule: "description_date", message: "no dates in a description — put them in structured output" });
  if (COUNT_RES.some((re) => re.test(text))) issues.push({ path, rule: "description_count", message: "no counts in a description — they go stale" });
  if (PRICE_RE.test(text)) issues.push({ path, rule: "description_price", message: "no prices or fees in a description — disclose them in the response" });
  if (SPONSOR_RE.test(text)) issues.push({ path, rule: "description_sponsorship", message: "no sponsorship in a description — it is data (sponsored), never copy" });
  if (CLAIM_RE.test(text)) issues.push({ path, rule: "description_claim", message: "no safety or superiority claims in a description" });
  return issues;
}
