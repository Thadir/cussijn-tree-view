#!/usr/bin/env bash
# Regenerates docs/screenshot.png from a real headless Thunderbird
# against entirely synthetic mail - see e2e/robot/screenshot.robot and
# e2e/fixtures/generate_fixture.py. Not part of CI; run by hand when the
# README's screenshot is worth refreshing.
# Usage: ./e2e/screenshot.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

IMAGE_TAG="cussijn-tree-view-e2e"
mkdir -p docs

podman build -t "$IMAGE_TAG" -f e2e/Containerfile .
podman run --rm -v "$PWD":/work --entrypoint bash "$IMAGE_TAG" -c '
  set -e
  cd /work
  command -v zip >/dev/null || (apt-get update && apt-get install -y --no-install-recommends zip)
  mkdir -p dist
  (cd extension && zip -qr -X ../dist/cussijn-tree-view.xpi . -x "*.test.js")
  export XPI_PATH="$PWD/dist/cussijn-tree-view.xpi"
  export TB_PROFILE_DIR=/tmp/cussijn-screenshot-profile
  export SCREENSHOT_PATH="$PWD/docs/screenshot.png"
  robot --pythonpath e2e/robot --outputdir e2e/results e2e/robot/screenshot.robot
'

echo ""
echo "Screenshot saved -> docs/screenshot.png"
