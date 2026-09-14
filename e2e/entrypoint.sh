#!/usr/bin/env bash
# Runs inside the e2e container (see e2e/Containerfile). Builds the
# extension the same way build/build.sh does (so the e2e suite always
# tests what CI actually packages, not a stale copy), then runs the
# Robot Framework smoke suite against it in a real, headless Thunderbird.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

command -v zip >/dev/null || (apt-get update && apt-get install -y --no-install-recommends zip)

echo "== Building extension =="
mkdir -p dist
rm -f dist/cussijn-tree-view.xpi
(cd extension && zip -qr -X ../dist/cussijn-tree-view.xpi . -x '*.test.js')

echo "== Running Robot Framework smoke suite against a real headless Thunderbird =="
mkdir -p e2e/results
export XPI_PATH="$PWD/dist/cussijn-tree-view.xpi"
export TB_PROFILE_DIR=/tmp/cussijn-e2e-profile
rm -rf "$TB_PROFILE_DIR"
mkdir -p "$TB_PROFILE_DIR"

robot --pythonpath e2e/robot --outputdir e2e/results e2e/robot/smoke.robot
