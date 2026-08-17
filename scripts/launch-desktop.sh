#!/bin/sh
# Clickable macOS launcher for Calorie Counter (Expo web).
#
# Starts (or reuses) the Expo web server on LAUNCH_PORT (default 8081),
# waits until that port actually serves this app, then opens /log in the
# default browser. The server keeps running in the background after this
# script exits, so the browser session stays usable.
#
# Env overrides:
#   LAUNCH_PORT      port to serve on (default 8081)
#   LAUNCH_NO_OPEN   when set, print the URL instead of opening a browser
#
# Exit codes: 0 = server serving and browser opened; 1 = port conflict or
# server failed to become ready within the timeout.

set -u

# Repository root from this script's location, never from the caller's cwd.
REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$REPO_ROOT" || exit 1

PORT=${LAUNCH_PORT:-8081}
BASE_URL="http://localhost:${PORT}"
APP_URL="${BASE_URL}/log"
LOG_FILE="${TMPDIR:-/tmp}/calorie-counter-web.log"
READY_TIMEOUT=60

# Local model bridge: the app fetches the CORS proxy; Metro inlines this URL.
export EXPO_PUBLIC_LLM_BASE_URL="${EXPO_PUBLIC_LLM_BASE_URL:-http://127.0.0.1:${LLM_PROXY_PORT:-8090}}"
if [ "${LLM_ENABLED:-1}" != "0" ]; then
  # Non-blocking and non-fatal: the app opens regardless; Settings shows the
  # bridge state if the model servers fail to come up.
  scripts/start-local-llm.sh >>"${TMPDIR:-/tmp}/calorie-counter-llm.log" 2>&1 &
fi

# Finder-launched bundles get a stripped PATH; add the standard node homes
# so `npm` resolves the same way it does from a terminal.
PATH="/opt/homebrew/bin:/usr/local/bin:${HOME}/.local/bin:${PATH}"
export PATH

notify() {
  # $1: message shown as a macOS notification; never fails the launcher.
  if command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"$1\" with title \"Calorie Counter\"" >/dev/null 2>&1 || true
  fi
}

open_app() {
  if [ -n "${LAUNCH_NO_OPEN:-}" ]; then
    echo "$APP_URL"
  else
    open "$APP_URL" 2>/dev/null || notify "Could not open browser at ${APP_URL}"
  fi
}

# True when the port answers with this app's Expo shell — not any old page.
server_serves_app() {
  body=$(curl -fsS -m 5 "${BASE_URL}/" 2>/dev/null) || return 1
  printf '%s' "$body" | grep -q 'Calorie Counter' || return 1
  printf '%s' "$body" | grep -q 'expo-router/entry.bundle'
}

port_in_use() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
}

if ! command -v npm >/dev/null 2>&1; then
  echo "Calorie Counter launcher: npm not found on PATH (${PATH})." >&2
  notify "npm was not found. Install Node.js and try again."
  exit 1
fi

if port_in_use; then
  if server_serves_app; then
    # Already serving this app: reuse it, never start a second server.
    open_app
    exit 0
  fi
  echo "Calorie Counter launcher: port ${PORT} is occupied by another service." >&2
  echo "Stop that service, or set LAUNCH_PORT to a free port (e.g. LAUNCH_PORT=8082)." >&2
  notify "Port ${PORT} is in use by another service. Stop it or set LAUNCH_PORT and try again."
  exit 1
fi

# Clean port: start the server in the background and wait for readiness.
if ! command -v nohup >/dev/null 2>&1; then
  echo "Calorie Counter launcher: nohup not available." >&2
  notify "Launcher failed: nohup not available."
  exit 1
fi

nohup npm run web -- --port "$PORT" >>"$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "Calorie Counter launcher: starting Expo web server on ${BASE_URL} (log: ${LOG_FILE})." >&2

i=0
while [ "$i" -lt "$READY_TIMEOUT" ]; do
  if server_serves_app; then
    open_app
    exit 0
  fi
  # Give up early if the server process died without ever binding the port.
  if ! kill -0 "$SERVER_PID" 2>/dev/null && ! port_in_use; then
    break
  fi
  sleep 1
  i=$((i + 1))
done

echo "Calorie Counter launcher: server did not become ready within ${READY_TIMEOUT}s." >&2
echo "See ${LOG_FILE} for server output." >&2
notify "Expo web server failed to start within ${READY_TIMEOUT}s. See ${LOG_FILE}."
exit 1
