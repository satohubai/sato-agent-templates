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

// One @satohub/kit build across every template, and each lockfile's record of
// it regenerated from the tarball (a stale lock entry once made the update
// policy compute a wrong MCP SDK bump).
import { readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const kitCells = cells
  .map((c) => ({ c, dir: join(ROOT, "templates", c.template, c.framework) }))
  .filter(({ dir }) => existsSync(join(dir, "vendor")) && readdirSync(join(dir, "vendor")).some((f) => /^satohub-kit-.*\.tgz$/.test(f)));
const kitTgz = (dir) => join(dir, "vendor", readdirSync(join(dir, "vendor")).find((f) => /^satohub-kit-.*\.tgz$/.test(f)));

test("every template vendors the same @satohub/kit tarball bytes", () => {
  const shas = new Set(kitCells.map(({ dir }) => createHash("sha256").update(readFileSync(kitTgz(dir))).digest("hex")));
  assert.equal(shas.size, 1, `distinct kit tarballs: ${[...shas].join(", ")}`);
});

test("every vendor/README.md names the same sato-hub-integrations sha", () => {
  const shas = new Set(kitCells.map(({ dir }) => {
    const m = readFileSync(join(dir, "vendor", "README.md"), "utf8").match(/sato-hub-integrations@([0-9a-f]{40})/);
    assert.ok(m, `${dir}/vendor/README.md names a full integrations sha`);
    return m[1];
  }));
  assert.equal(shas.size, 1, `distinct integrations shas: ${[...shas].join(", ")}`);
});

for (const { c, dir } of kitCells) {
  test(`${c.template}/${c.framework}: lockfile @satohub/kit entry matches the vendored tarball`, () => {
    const tgz = kitTgz(dir);
    const kit = JSON.parse(execFileSync("tar", ["-xzOf", tgz, "package/package.json"], { encoding: "utf8" }));
    const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8"));
    const e = lock.packages?.["node_modules/@satohub/kit"];
    assert.ok(e, "lock has node_modules/@satohub/kit");
    assert.equal(e.version, kit.version, "version");
    assert.equal(e.integrity, "sha512-" + createHash("sha512").update(readFileSync(tgz)).digest("base64"), "integrity");
    assert.deepEqual(e.dependencies ?? {}, kit.dependencies ?? {}, "dependencies");
    assert.deepEqual(e.peerDependencies ?? {}, kit.peerDependencies ?? {}, "peerDependencies");
  });
}
