#!/usr/bin/env bash
# Local (non-podman) fallback for build.sh, for dev environments where
# rootless podman can't run (this sandbox: cgroup/dbus permission errors
# under WSL2 - see CLAUDE.md). Same lint/test steps, but zips with
# python3's zipfile instead of the `zip` binary (not installed here),
# and copies the result to Thadir's SequoiaView install folder too.
#
# The packaged manifest.json's version gets a 4th, all-numeric segment
# (a build timestamp: 1.0.1.202609161930) that the checked-in
# extension/manifest.json never sees - only the copy that gets zipped is
# patched. Thunderbird's version comparator treats a bigger 4th segment
# as strictly newer, so re-running "Install Add-on From File" on a fresh
# build is always recognized as an update instead of a no-op - found
# live: with every local build sharing manifest.json's real, unbumped
# "1.0.1", Thunderbird sometimes silently kept the old install running.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "== JS syntax check =="
for f in extension/*.js; do
  echo "  node --check $f"
  node --check "$f"
done

echo "== JS unit tests =="
node --test extension/*.test.js

echo "== Packaging extension as .xpi (version stamped for local testing) =="
STAMP="$(date +%Y%m%d%H%M)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
cp -r extension/. "$TMPDIR/"
rm -f "$TMPDIR"/*.test.js

python3 - "$TMPDIR/manifest.json" "$STAMP" <<'PY'
import json, sys
path, stamp = sys.argv[1], sys.argv[2]
with open(path) as f:
    manifest = json.load(f)
manifest["version"] = f'{manifest["version"]}.{stamp}'
with open(path, "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
PY

mkdir -p dist
rm -f dist/cussijn-tree-view.xpi
python3 - "$TMPDIR" "dist/cussijn-tree-view.xpi" <<'PY'
import zipfile, os, sys
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, _dirs, files in os.walk(src):
        for name in files:
            full = os.path.join(root, name)
            z.write(full, os.path.relpath(full, src))
PY

echo ""
echo "Build OK -> dist/cussijn-tree-view.xpi (version: $(python3 -c "import json; print(json.load(open('$TMPDIR/manifest.json'))['version'])"))"

DEST="/mnt/c/Users/Thadir/Documents/SequoiaView/cussijn-tree-view.xpi"
if [ -d "$(dirname "$DEST")" ]; then
  rm -f "$DEST"
  cat dist/cussijn-tree-view.xpi > "$DEST"
  echo "Copied -> $DEST"
fi
