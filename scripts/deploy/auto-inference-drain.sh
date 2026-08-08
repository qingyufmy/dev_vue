#!/usr/bin/env bash
set -Eeuo pipefail

# Generic deployment wrapper. The remote BaoTa deploy.sh can either call the
# begin/wait/end CLI directly or invoke this wrapper with the restart command:
#   bash scripts/deploy/auto-inference-drain.sh -- bash ./restart-service.sh
# No server address, credential, or BaoTa-specific path is embedded here.

APP_DIR="${AURUM_APP_DIR:-$(pwd)}"
DRAIN_CLI="${AURUM_DRAIN_CLI:-$APP_DIR/scripts/deploy/auto-inference-drain.mjs}"
DRAIN_TTL_SECONDS="${DRAIN_TTL_SECONDS:-900}"
DRAIN_WAIT_TIMEOUT_SECONDS="${DRAIN_WAIT_TIMEOUT_SECONDS:-$DRAIN_TTL_SECONDS}"
DRAIN_POLL_SECONDS="${DRAIN_POLL_SECONDS:-5}"
DRAIN_TOKEN=""

cd "$APP_DIR"

cleanup_drain() {
  if [[ -n "$DRAIN_TOKEN" ]]; then
    node "$DRAIN_CLI" end --token "$DRAIN_TOKEN" >/dev/null 2>&1 || true
  fi
}
trap cleanup_drain EXIT INT TERM

begin_json="$(node "$DRAIN_CLI" begin --ttl-seconds "$DRAIN_TTL_SECONDS")"
DRAIN_TOKEN="$(node -e 'const value=JSON.parse(process.argv[1]); if (!value.ok || !value.token) process.exit(2); process.stdout.write(value.token)' "$begin_json")"
node "$DRAIN_CLI" wait \
  --token "$DRAIN_TOKEN" \
  --ttl-seconds "$DRAIN_TTL_SECONDS" \
  --timeout-seconds "$DRAIN_WAIT_TIMEOUT_SECONDS" \
  --poll-seconds "$DRAIN_POLL_SECONDS"

if [[ "$#" -gt 0 ]]; then
  if [[ "$1" == "--" ]]; then shift; fi
  if [[ "$#" -gt 0 ]]; then "$@"; fi
fi
