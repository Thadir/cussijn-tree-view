#!/usr/bin/env bash
# Scans extension/ with a SonarQube Community server running in a container,
# then prints the quality gate result and headline metrics. Unit tests run
# first, with coverage, and feed Sonar's coverage numbers. Report only: it
# exits 0 whatever the gate says, and fails only if the tests or the scan
# themselves break.
#
# Locally (podman) the server is left running afterwards so the results can
# be browsed at http://localhost:9000 (login admin/admin, or set
# SONAR_ADMIN_PASSWORD if you changed it). Re-running reuses that server.
# CI runs it with CONTAINER_ENGINE=docker.
#
#   ./build/sonar.sh          scan
#   ./build/sonar.sh stop     remove the server container and its data
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

ENGINE="${CONTAINER_ENGINE:-podman}"
NAME=cussijn-sonarqube
URL=http://localhost:9000
PROJECT_KEY=cussijn-tree-view
ADMIN_PASSWORD="${SONAR_ADMIN_PASSWORD:-admin}"
SERVER_IMAGE=docker.io/library/sonarqube:community
SCANNER_IMAGE=docker.io/sonarsource/sonar-scanner-cli:latest
NODE_IMAGE=docker.io/library/node:20-slim

if [ "${1:-}" = "stop" ]; then
  "$ENGINE" rm -f "$NAME"
  exit 0
fi

json() { python3 -c "import sys, json; d = json.load(sys.stdin); print($1)"; }

echo "== SonarQube server =="
if "$ENGINE" inspect "$NAME" >/dev/null 2>&1; then
  [ "$("$ENGINE" inspect -f '{{.State.Running}}' "$NAME")" = "true" ] || "$ENGINE" start "$NAME" >/dev/null
else
  # mmap is off because a stock Linux host (including GitHub runners) has a
  # vm.max_map_count too low for Elasticsearch's default mmapfs store.
  "$ENGINE" run -d --name "$NAME" -p 9000:9000 \
    -e SONAR_SEARCH_JAVAADDITIONALOPTS=-Dnode.store.allow_mmap=false \
    "$SERVER_IMAGE" >/dev/null
fi

status=""
for _ in $(seq 1 90); do
  status=$(curl -fsS "$URL/api/system/status" 2>/dev/null | json 'd.get("status", "")' 2>/dev/null || true)
  [ "$status" = "UP" ] && break
  sleep 5
done
if [ "$status" != "UP" ]; then
  echo "SonarQube did not reach UP (last status: '${status}')." >&2
  "$ENGINE" logs --tail 50 "$NAME" >&2
  exit 1
fi

token=$(curl -fsS -u "admin:${ADMIN_PASSWORD}" -X POST "$URL/api/user_tokens/generate" \
  -d "name=scan-$(date +%s)" | json 'd["token"]')

echo "== Unit tests with coverage =="
# lcov goes to a file, the readable spec report to the console.
rm -rf coverage
mkdir -p coverage
"$ENGINE" run --rm -v "$PWD":/usr/src -w /usr/src "$NODE_IMAGE" \
  node --test --experimental-test-coverage \
  --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter=lcov --test-reporter-destination=coverage/lcov.info \
  extension/*.test.js

echo "== Scanning extension/ =="
rm -rf .scannerwork
"$ENGINE" run --rm --user 0:0 --network=host -v "$PWD":/usr/src \
  -e SONAR_HOST_URL="$URL" -e SONAR_TOKEN="$token" "$SCANNER_IMAGE" \
  -Dsonar.working.directory=/usr/src/.scannerwork

echo "== Waiting for the server to finish processing =="
ce_url=$(sed -n 's/^ceTaskUrl=//p' .scannerwork/report-task.txt)
task_status=""
for _ in $(seq 1 60); do
  task_status=$(curl -fsS -u "${token}:" "$ce_url" | json 'd["task"]["status"]')
  case "$task_status" in
    SUCCESS) break ;;
    FAILED|CANCELED) echo "Server-side analysis ended as $task_status." >&2; exit 1 ;;
  esac
  sleep 3
done
[ "$task_status" = "SUCCESS" ] || { echo "Timed out waiting for analysis." >&2; exit 1; }

gate=$(curl -fsS -u "${token}:" "$URL/api/qualitygates/project_status?projectKey=${PROJECT_KEY}" \
  | json 'd["projectStatus"]["status"]')
metrics=$(curl -fsS -u "${token}:" \
  "$URL/api/measures/component?component=${PROJECT_KEY}&metricKeys=bugs,vulnerabilities,code_smells,security_hotspots,coverage,duplicated_lines_density,ncloc" \
  | python3 -c '
import sys, json
for m in json.load(sys.stdin)["component"]["measures"]:
    print(m["metric"] + ": " + m["value"])
')

report="Quality gate: ${gate}
${metrics}"
echo ""
echo "== Result =="
echo "$report"
echo "Dashboard: ${URL}/dashboard?id=${PROJECT_KEY}"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### SonarQube"
    echo '```'
    echo "$report"
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
fi
