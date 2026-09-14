#!/usr/bin/env bash
# Build and run the real-Thunderbird E2E smoke suite in a reproducible
# podman container. Usage: ./e2e/run.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

IMAGE_TAG="cussijn-tree-view-e2e"

podman build -t "$IMAGE_TAG" -f e2e/Containerfile .
podman run --rm -v "$PWD":/work "$IMAGE_TAG"
