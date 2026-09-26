#!/usr/bin/env bash
# Rebuild the vendored @satohub/kit tarball from a ref of
# satohubai/sato-hub-integrations, until the kit is published to npm.
#
#   scripts/vendor-kit.sh <ref> [template-dir ...]
#
# <ref> is a branch, tag or commit sha. With no template dirs, every
# templates/*/*/vendor directory that already holds a kit tarball is refreshed.
# After it runs, re-lock each template (`npm install --package-lock-only`
# inside it) so package-lock.json records the new tarball's integrity.
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
  echo "vendored $NAME from $SHA into $dir/vendor"
done
