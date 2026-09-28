// Repo-level consistency of every template's pins (runs on every CI).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverCells } from "./discover-templates.mjs";
import { parseSemver, runtimeMajor } from "./lib/upgrade-policy.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const cells = discoverCells(ROOT);
const read = (c, f) => JSON.parse(readFileSync(join(ROOT, "templates", c.template, c.framework, f), "utf8"));

test("there are templates to check", () => assert.ok(cells.length >= 1));

for (const c of cells) {
  const id = `${c.template}/${c.framework}`;
  const pkg = read(c, "package.json");
  const manifest = read(c, "sato.template.json");
  const all = { ...pkg.dependencies, ...pkg.devDependencies };

  test(`${id}: @types/node major equals the runtime major`, () => {
    const rt = runtimeMajor(manifest);
    assert.ok(rt, "sato.template.json runtime.version");
    assert.ok(all["@types/node"], "@types/node is pinned");
    assert.equal(parseSemver(all["@types/node"])?.major, rt);
  });

  test(`${id}: every package.json pin is exact (or the vendored tarball)`, () => {
    for (const [name, spec] of Object.entries(all)) {
      if (String(spec).startsWith("file:")) { assert.match(spec, /^file:vendor\/[^/]+\.tgz$/, name); continue; }
      const s = parseSemver(spec);
      assert.ok(s && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(spec), `${name}: ${spec} is not an exact version`);
    }
  });

  test(`${id}: sato.template.json upstream pins equal package.json`, () => {
    const up = manifest.template?.upstream ?? {};
    assert.ok(Object.keys(up).length, "template.upstream is present");
    for (const [name, v] of Object.entries(up)) {
      const spec = all[name];
      assert.ok(spec, `${name} is in upstream but not in package.json`);
      if (String(spec).startsWith("file:")) assert.ok(spec.endsWith(`-${v}.tgz`), `${name}: upstream ${v} vs ${spec}`);
      else assert.equal(spec, v, name);
    }
  });
}
