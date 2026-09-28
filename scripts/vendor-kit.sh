#!/usr/bin/env bash
# Rebuild the vendored @satohub/kit tarball from a ref of
# satohubai/sato-hub-integrations, until the kit is published to npm.
#
#   scripts/vendor-kit.sh <ref> [template-dir ...]
#
# <ref> is a branch, tag or commit sha. With no template dirs, every
# templates/*/*/vendor directory that already holds a kit tarball is refreshed.
# It also regenerates the kit's entry in each template's package-lock.json from
# the tarball (npm --package-lock-only). Run `npm ci` inside the template
# afterwards to check the lock installs.
set -euo pipefail

REF="${1:?usage: scripts/vendor-kit.sh <ref> [template-dir ...]}"
shift || true
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="https://github.com/satohubai/sato-hub-integrations.git"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git clone --quiet --filter=blob:none "$REPO" "$WORK/src"
git -C "$WORK/src" checkout --quiet "$REF"
SHA="$(git -C "$WORK/src" rev-parse HEAD)"

(
  cd "$WORK/src"
  npm install --no-fund --no-audit --ignore-scripts >/dev/null
  npm run build -w @satohub/kit >/dev/null
  npm pack -w @satohub/kit --pack-destination "$WORK" >/dev/null
)
TGZ="$(ls "$WORK"/satohub-kit-*.tgz | head -n1)"
NAME="$(basename "$TGZ")"

if [ "$#" -eq 0 ]; then
  set -- $(ls -d "$ROOT"/templates/*/*/ 2>/dev/null)
fi

for dir in "$@"; do
  dir="${dir%/}"
  [ -d "$dir" ] || { echo "skip: $dir is not a directory" >&2; continue; }
  mkdir -p "$dir/vendor"
  rm -f "$dir"/vendor/satohub-kit-*.tgz
  cp "$TGZ" "$dir/vendor/$NAME"
  cat > "$dir/vendor/README.md" <<MD
# vendor/

Preview build of @satohub/kit, vendored until the package is published to npm; built from satohubai/sato-hub-integrations@${SHA}.

Rebuild with \`scripts/vendor-kit.sh <ref>\` at the root of satohubai/sato-agent-templates.
MD
  if [ -f "$dir/package-lock.json" ]; then
    # Regenerate the kit's lock entry from the tarball itself (version,
    # integrity, dependencies, peerDependencies, bin). Rewriting only the
    # integrity left stale dependency metadata behind, which made the update
    # policy compute wrong bumps. Dropping the entry first stops npm reusing
    # the cached metadata for an unchanged file: path; anything else in the
    # lock moves only as far as the kit's own dependency set requires.
    cp "$dir/package-lock.json" "$WORK/lock.before.json"
    node -e 'const fs=require("fs");const f=process.argv[1];const l=JSON.parse(fs.readFileSync(f,"utf8"));if(l.packages)delete l.packages["node_modules/@satohub/kit"];fs.writeFileSync(f,JSON.stringify(l,null,2)+"\n");' "$dir/package-lock.json"
    (cd "$dir" && npm install "./vendor/$NAME" --package-lock-only --save-exact --ignore-scripts \
      --no-audit --no-fund --registry=https://registry.npmjs.org/ >/dev/null)
    # npm 11 prunes entries marked "extraneous" (optional peers such as
    # utf-8-validate) that npm 10's `npm ci` still expects; put back any such
    # entry npm dropped, unchanged, so the lock moves only for the kit.
    node -e 'const fs=require("fs");const [f,b]=process.argv.slice(1);const l=JSON.parse(fs.readFileSync(f,"utf8"));const old=JSON.parse(fs.readFileSync(b,"utf8")).packages||{};let n=0;for(const [k,v] of Object.entries(old)){if(v&&v.extraneous&&!(k in l.packages)){l.packages[k]=v;n++;}}if(n){l.packages=Object.fromEntries(Object.entries(l.packages).sort(([a],[c])=>a.localeCompare(c,"en")));fs.writeFileSync(f,JSON.stringify(l,null,2)+"\n");}' "$dir/package-lock.json" "$WORK/lock.before.json"
    INTEGRITY="sha512-$(openssl dgst -sha512 -binary "$dir/vendor/$NAME" | base64 | tr -d '\n')"
    node -e 'const fs=require("fs");const [f,i]=process.argv.slice(1);const p=JSON.parse(fs.readFileSync(f,"utf8")).packages["node_modules/@satohub/kit"];if(!p||p.integrity!==i){console.error("kit lock entry missing or integrity mismatch in "+f);process.exit(1);}' "$dir/package-lock.json" "$INTEGRITY"
  fi
  echo "vendored $NAME from $SHA into $dir/vendor"
done
