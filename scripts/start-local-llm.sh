#!/bin/sh
# Local model bridge lifecycle: needle (parser) + Bonsai/mlx (planner) servers
# plus the CORS proxy the app fetches. Reuse/readiness style mirrors
# scripts/launch-desktop.sh: never start a duplicate, never kill an occupant.
#
# Env:
#   LLM_BACKEND        needle (default) | bonsai | both (default when unset:
#                      needle always; Bonsai unless LLM_BONSAI_ENABLED=0)
#   LLM_PORT           needle server port (default 8080)
#   LLM_BONSAI_PORT    mlx_lm.server port (default 8082)
#   LLM_HOST           bind host (default 127.0.0.1)
#   LLM_PROXY_PORT     CORS proxy port (default 8090)
#   LLM_PROXY_ENABLED  0 disables the proxy (default 1)
#   LLM_BIN            needle binary path (default: cache dir)
#   LLM_PYTHON         python interpreter with mlx-lm (default: python3)
#   LLM_BONSAI_MODEL   mlx HF repo (default prism-ml/Ternary-Bonsai-4B-mlx-2bit)
#   LLM_BONSAI_ENABLED 0 skips Bonsai (default 1)
#
# Exit codes: 0 = bridge (or the enabled parts) ready; 1 = needle failed
# (the app's parser dependency). Bonsai failure is non-fatal.

set -u

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$REPO_ROOT" || exit 1

HOST=${LLM_HOST:-127.0.0.1}
PORT=${LLM_PORT:-8080}
BONSAI_PORT=${LLM_BONSAI_PORT:-8082}
PROXY_PORT=${LLM_PROXY_PORT:-8090}
BONSAI_MODEL=${LLM_BONSAI_MODEL:-prism-ml/Ternary-Bonsai-4B-mlx-2bit}
LLM_PYTHON=${LLM_PYTHON:-python3}
BACKEND=${LLM_BACKEND:-both}
LLM_BIN_EXPLICIT=0
if [ -n "${LLM_BIN:-}" ]; then
  LLM_BIN_EXPLICIT=1
fi
NEEDLE_CACHE=${LLM_BIN:-"${HOME}/Library/Caches/calorie-counter/needle/macos-arm64/needle"}
LOG_FILE="${TMPDIR:-/tmp}/calorie-counter-llm.log"
BONSAI_LOG="${TMPDIR:-/tmp}/calorie-counter-bonsai.log"
PROXY_LOG="${TMPDIR:-/tmp}/calorie-counter-llm-proxy.log"

want_needle() {
  [ "$BACKEND" = "needle" ] || [ "$BACKEND" = "both" ]
}
want_bonsai() {
  [ "$BACKEND" = "bonsai" ] || [ "$BACKEND" = "both" ]
}

needle_health() {
  curl -fsS -m 5 -X POST "http://${HOST}:${PORT}/complete" \
    -H 'Content-Type: application/json' -d '{"input":"ping"}' >/dev/null 2>&1
}

bonsai_health() {
  curl -fsS -m 5 "http://${HOST}:${BONSAI_PORT}/v1/models" >/dev/null 2>&1
}

start_needle() {
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    if needle_health; then
      echo "reusing existing needle server on http://${HOST}:${PORT}"
      return 0
    fi
    echo "error: port ${PORT} is occupied by a non-needle service; stop it or set LLM_PORT" >&2
    return 1
  fi

  if [ ! -f "$NEEDLE_CACHE" ]; then
    if [ "$LLM_BIN_EXPLICIT" = "1" ]; then
      echo "error: LLM_BIN=$NEEDLE_CACHE not found" >&2
      return 1
    fi
    echo "downloading needle binary (14.6 MB) to ${NEEDLE_CACHE} …"
    mkdir -p "$(dirname "$NEEDLE_CACHE")" || return 1
    curl -fsSL -o "$NEEDLE_CACHE" \
      "https://huggingface.co/Cactus-Compute/needle2/resolve/main/macos-arm64/needle" || {
      rm -f "$NEEDLE_CACHE"
      echo "error: needle binary download failed (network?). Retry on next launch." >&2
      return 1
    }
    SIZE=$(wc -c <"$NEEDLE_CACHE" 2>/dev/null || echo 0)
    LOW=$((14594024 - 1024)); HIGH=$((14594024 + 1024))
    if [ "$SIZE" -lt "$LOW" ] || [ "$SIZE" -gt "$HIGH" ]; then
      rm -f "$NEEDLE_CACHE"
      echo "error: needle binary failed size verification (got ${SIZE} bytes); re-download next launch" >&2
      return 1
    fi
    chmod +x "$NEEDLE_CACHE"
    # Apple Silicon's kernel SIGKILLs unsigned arm64 executables; ad-hoc
    # signing is required for downloaded binaries. (Re-signing an already
    # signed binary is harmless, so this also runs on the cached path.)
    command -v codesign >/dev/null 2>&1 && codesign -s - "$NEEDLE_CACHE" >/dev/null 2>&1 || true
  fi
  if [ ! -x "$NEEDLE_CACHE" ]; then
    echo "error: LLM_BIN=$NEEDLE_CACHE is not an executable file" >&2
    return 1
  fi
  # Re-sign cached binaries too (idempotent) in case the cache predates signing.
  command -v codesign >/dev/null 2>&1 && codesign -s - "$NEEDLE_CACHE" >/dev/null 2>&1 || true

  # The needle CLI supports --port (verified in the binary); bind the
  # configured port so the proxy and app stay in sync.
  nohup "$NEEDLE_CACHE" --tools "$REPO_ROOT/scripts/needle-tools.json" --serve --port "$PORT" \
    >>"$LOG_FILE" 2>&1 &
  SERVER_PID=$!

  i=0
  while [ "$i" -lt 60 ]; do
    if needle_health; then
      echo "needle server ready on http://${HOST}:${PORT}"
      return 0
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null && ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      break
    fi
    sleep 1
    i=$((i + 1))
  done
  echo "error: needle server did not become ready within 60s (see ${LOG_FILE})" >&2
  tail -5 "$LOG_FILE" >&2 2>/dev/null
  return 1
}

start_bonsai() {
  if lsof -nP -iTCP:"$BONSAI_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    if bonsai_health; then
      echo "reusing existing bonsai server on http://${HOST}:${BONSAI_PORT}"
      return 0
    fi
    echo "warning: port ${BONSAI_PORT} occupied by a non-model service; Bonsai disabled" >&2
    return 0
  fi
  if ! "$LLM_PYTHON" -c 'import mlx_lm' >/dev/null 2>&1; then
    echo "warning: mlx-lm not installed for $LLM_PYTHON; Bonsai planner disabled (run: pip install mlx mlx-lm)" >&2
    return 0
  fi
  echo "starting Bonsai planner (${BONSAI_MODEL}; first start downloads the model) …"
  nohup "$LLM_PYTHON" -m mlx_lm.server --model "$BONSAI_MODEL" --host "$HOST" --port "$BONSAI_PORT" \
    >>"$BONSAI_LOG" 2>&1 &
  SERVER_PID=$!
  i=0
  while [ "$i" -lt 180 ]; do
    if bonsai_health; then
      echo "bonsai server ready on http://${HOST}:${BONSAI_PORT}"
      return 0
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null && ! lsof -nP -iTCP:"$BONSAI_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      break
    fi
    sleep 1
    i=$((i + 1))
  done
  echo "warning: Bonsai did not become ready (see ${BONSAI_LOG}); continuing needle-only" >&2
  tail -5 "$BONSAI_LOG" >&2 2>/dev/null
  return 0
}

start_proxy() {
  if lsof -nP -iTCP:"$PROXY_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "reusing existing proxy on http://${HOST}:${PROXY_PORT}"
    return 0
  fi
  nohup node "$REPO_ROOT/scripts/local-llm-proxy.mjs" >>"$PROXY_LOG" 2>&1 &
  i=0
  while [ "$i" -lt 10 ]; do
    if curl -fsS -m 3 "http://${HOST}:${PROXY_PORT}/health" >/dev/null 2>&1; then
      echo "proxy ready on http://${HOST}:${PROXY_PORT}"
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  echo "error: proxy did not become ready (see ${PROXY_LOG})" >&2
  return 1
}

FAILED=0
if want_needle; then
  start_needle || FAILED=1
fi
if want_bonsai && [ "${LLM_BONSAI_ENABLED:-1}" != "0" ]; then
  start_bonsai
fi
if [ "${LLM_PROXY_ENABLED:-1}" != "0" ]; then
  start_proxy || FAILED=1
fi

if [ "$FAILED" -ne 0 ]; then
  echo "local model bridge failed" >&2
  exit 1
fi
echo "local model bridge ready on http://${HOST}:${PROXY_PORT}"
exit 0
