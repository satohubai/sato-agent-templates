// SKILL.md frontmatter: the small YAML subset skills use (scalar keys, quoted
// strings, and folded ">" / literal "|" blocks). Pure; returns null when the
// file has no frontmatter.

function unquote(v) {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

export function parseFrontmatter(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.indexOf("---", 1);
  const endAlt = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  const stop = end > 0 ? end : endAlt;
  if (stop < 0) return null;
  const out = {};
  for (let i = 1; i < stop; i++) {
    const m = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, rest] = m;
    const block = rest.trim().match(/^([>|])[-+]?$/);
    if (block) {
      const body = [];
      while (i + 1 < stop && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) body.push(lines[++i].trim());
      out[key] = block[1] === ">" ? body.filter(Boolean).join(" ") : body.join("\n").trim();
    } else {
      out[key] = unquote(rest);
    }
  }
  return out;
}

/** Conformance for a skill: frontmatter present, a description, and the name its directory has. */
export function skillConformance(text, expectedName) {
  const fm = parseFrontmatter(text);
  if (!fm) return { result: "fail", step: "parse", detail: "SKILL.md has no frontmatter" };
  if (!fm.description) return { result: "fail", step: "assert", detail: "the frontmatter has no description" };
  if (fm.name !== expectedName) return { result: "fail", step: "assert", detail: `the frontmatter names the skill ${JSON.stringify(fm.name ?? null)}, its directory is ${expectedName}` };
  return { result: "pass", step: null, detail: null };
}
