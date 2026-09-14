#!/usr/bin/env bash
# Runs INSIDE the podman build container (see build/Containerfile and
# build/run.sh). Lints, tests, and packages the extension.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "== JS syntax check =="
for f in extension/*.js; do
  echo "  node --check $f"
  node --check "$f"
done

echo "== JS unit tests =="
# --experimental-test-coverage reports the real, current number every
# build - the README's coverage badge is a static snapshot (see its
# caveat there for why line coverage on this file specifically needs
# context, not just a bigger/smaller number); this is how to check
# today's actual figure.
node --test --experimental-test-coverage extension/*.test.js

echo "== Packaging extension as .xpi =="
mkdir -p dist
rm -f dist/cussijn-tree-view.xpi
(cd extension && zip -qr -X ../dist/cussijn-tree-view.xpi . -x '*.test.js')

echo ""
echo "Build OK -> dist/cussijn-tree-view.xpi"
