#!/bin/sh
# Deterministic smoke checks for the Calorie Counter desktop launcher.
# Uses only macOS system tools (curl, lsof, plutil) plus the repo's own
# node/npm. Runs on controlled test ports (18081-18083) so a user's real
# server on 8081 is never touched. Standalone: not part of `npm test`,
# because it starts real Expo servers.
#
# Checks:
#   1. bundle has the required Info.plist keys and executable entrypoint
#   2. a running local server is reused, not duplicated
#   3. a clean port starts Expo and reaches http://localhost:PORT/log
#   4. an occupied port reports an error without killing the occupant

set -u

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$REPO_ROOT"

LAUNCHER="$REPO_ROOT/scripts/launch-desktop.sh"
BUNDLE="$REPO_ROOT/desktop/Calorie Counter.app"
P1=18081
P2=18082
P3=18083
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

# Kill everything this script started, scoped to the test ports only.
cleanup() {
  for p in "$P1" "$P2" "$P3"; do
    for pid in $(lsof -tnP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null); do
      kill "$pid" 2>/dev/null
    done
    # npm parents and expo children launched for the test ports
    for pid in $(pgrep -f "port $p" 2>/dev/null); do
      kill "$pid" 2>/dev/null
    done
  done
}
trap cleanup EXIT

# Wait until a URL serves this app's Expo shell; timeout in seconds ($2).
wait_for_app() {
  url=$1
  timeout=$2
  i=0
  while [ "$i" -lt "$timeout" ]; do
    body=$(curl -fsS -m 5 "$url" 2>/dev/null) || {
      i=$((i + 1))
      sleep 1
      continue
    }
    if printf '%s' "$body" | grep -q 'Calorie Counter' &&
      printf '%s' "$body" | grep -q 'expo-router/entry.bundle'; then
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  return 1
}

echo "== Check 1: bundle structure =="
plutil -lint "$BUNDLE/Contents/Info.plist" >/dev/null 2>&1 \
  && pass "Info.plist parses" || fail "Info.plist does not parse"
check_plist() {
  [ "$(plutil -extract "$1" raw "$BUNDLE/Contents/Info.plist" 2>/dev/null)" = "$2" ]
}
check_plist CFBundleIdentifier com.caloriecounter.desktop && pass "CFBundleIdentifier" || fail "CFBundleIdentifier"
check_plist CFBundleName "Calorie Counter" && pass "CFBundleName" || fail "CFBundleName"
check_plist CFBundleDisplayName "Calorie Counter" && pass "CFBundleDisplayName" || fail "CFBundleDisplayName"
check_plist CFBundleExecutable "Calorie Counter" && pass "CFBundleExecutable" || fail "CFBundleExecutable"
check_plist CFBundlePackageType APPL && pass "CFBundlePackageType" || fail "CFBundlePackageType"
check_plist CFBundleVersion 1.0.0 && pass "CFBundleVersion" || fail "CFBundleVersion"
check_plist LSMinimumSystemVersion 12.0 && pass "LSMinimumSystemVersion" || fail "LSMinimumSystemVersion"
[ -x "$BUNDLE/Contents/MacOS/Calorie Counter" ] && pass "entrypoint executable" || fail "entrypoint not executable"
[ -x "$LAUNCHER" ] && pass "launcher script executable" || fail "launcher script not executable"

echo "== Check 2: running server is reused, not duplicated =="
nohup npm run web -- --port "$P1" >"${TMPDIR:-/tmp}/cc-smoke-server.log" 2>&1 &
SERVER_PID=$!
if ! wait_for_app "http://localhost:$P1/" 120; then
  fail "test server did not start on $P1"
else
  ORIG_LISTENER=$(lsof -tnP -iTCP:"$P1" -sTCP:LISTEN 2>/dev/null | head -1)
  OUT=$(LAUNCH_PORT=$P1 LAUNCH_NO_OPEN=1 sh "$LAUNCHER" 2>&1)
  RC=$?
  NEW_LISTENER=$(lsof -tnP -iTCP:"$P1" -sTCP:LISTEN 2>/dev/null | head -1)
  [ "$RC" -eq 0 ] && pass "launcher reuses server (exit 0)" || fail "launcher exit $RC: $OUT"
  printf '%s' "$OUT" | grep -q "http://localhost:$P1/log" && pass "launcher printed app URL" || fail "no app URL in output: $OUT"
  [ -n "$ORIG_LISTENER" ] && [ "$NEW_LISTENER" = "$ORIG_LISTENER" ] \
    && pass "no duplicate server (listener unchanged)" || fail "listener changed: $ORIG_LISTENER -> $NEW_LISTENER"
  kill -0 "$SERVER_PID" 2>/dev/null && pass "original server still running" || fail "original server died"
fi
kill "$SERVER_PID" 2>/dev/null
sleep 1

echo "== Check 3: clean port starts Expo and reaches /log =="
OUT=$(LAUNCH_PORT=$P2 LAUNCH_NO_OPEN=1 sh "$LAUNCHER" 2>&1)
RC=$?
[ "$RC" -eq 0 ] && pass "launcher started server (exit 0)" || fail "launcher exit $RC: $OUT"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "http://localhost:$P2/log")
[ "$code" = "200" ] && pass "GET /log returns 200" || fail "GET /log returned $code"

echo "== Check 4: occupied port reports error and keeps occupant alive =="
# A non-Calorie-Counter HTTP service occupying the port (node: instant bind,
# serves a foreign page that must not match the app markers).
PORT=$P3 node -e 'require("http").createServer((_q, s) => { s.writeHead(200, {"Content-Type": "text/html"}); s.end("<html><title>Other Service</title></html>"); }).listen(process.env.PORT, "127.0.0.1")' >"${TMPDIR:-/tmp}/cc-smoke-dummy.log" 2>&1 &
DUMMY_PID=$!
i=0
while [ "$i" -lt 30 ] && ! lsof -nP -iTCP:"$P3" -sTCP:LISTEN >/dev/null 2>&1; do
  sleep 1
  i=$((i + 1))
done
if ! lsof -nP -iTCP:"$P3" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "dummy listener did not come up on $P3"
else
  OUT=$(LAUNCH_PORT=$P3 LAUNCH_NO_OPEN=1 sh "$LAUNCHER" 2>&1)
  RC=$?
  [ "$RC" -ne 0 ] && pass "launcher fails on occupied port (exit $RC)" || fail "launcher succeeded on occupied port: $OUT"
  printf '%s' "$OUT" | grep -q "$P3" && pass "error mentions port $P3" || fail "error lacks port: $OUT"
  kill -0 "$DUMMY_PID" 2>/dev/null && pass "occupant left alive" || fail "occupant was killed"
fi
kill "$DUMMY_PID" 2>/dev/null

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
