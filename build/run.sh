#!/usr/bin/env bash
# Build and test this project inside a reproducible podman container.
# Usage: ./build/run.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

IMAGE_TAG="cussijn-tree-view-build"

podman build -t "$IMAGE_TAG" -f build/Containerfile .
podman run --rm -v "$PWD":/work "$IMAGE_TAG"
