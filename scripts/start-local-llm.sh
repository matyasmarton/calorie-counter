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
#   LLM_BONSAI_RUNNER  auto (default) | mlx_lm | omlx — which runtime serves
#                      the Bonsai backend. auto prefers mlx_lm.server when the
#                      python interpreter has mlx-lm, else `omlx serve`.
#   LLM_BONSAI_API_KEY bearer token for the Bonsai backend; required when the
#                      omlx runner is keyed (default: the oMLX settings.json
#                      auth.api_key when the omlx runner is selected)
#   OMLX_BIN           oMLX CLI (default: `omlx` on PATH, else ~/.omlx/bin/omlx)
#   OMLX_LIBRARY_DIR   oMLX model library (default ~/.omlx/models); the proxy
#                      browses it and the docker-free omlx runner serves it
#   MODEL_DOWNLOAD_CMD override command template the proxy runs per download
#                      ({ID}/{REPO}/{DEST} substituted); empty means the
#                      proxy's built-in Hugging Face downloader
#
# PID files — written for servers THIS script starts, and read by the proxy's
# POST /models/use so it never kills a process it does not own. Namespaced by
# port, so a bridge on test ports cannot clobber the real bridge's records:
#   ${TMPDIR:-/tmp}/calorie-counter-<needle|bonsai|proxy>-<port>.pid
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
BONSAI_RUNNER=${LLM_BONSAI_RUNNER:-auto}
OMLX_LIBRARY_DIR=${OMLX_LIBRARY_DIR:-"${HOME}/.omlx/models"}
OMLX_SETTINGS="${HOME}/.omlx/settings.json"
if [ -z "${OMLX_BIN:-}" ]; then
  if command -v omlx >/dev/null 2>&1; then
    OMLX_BIN=$(command -v omlx)
  elif [ -x "${HOME}/.omlx/bin/omlx" ]; then
    OMLX_BIN="${HOME}/.omlx/bin/omlx"
  else
    OMLX_BIN=""
  fi
fi
LLM_BIN_EXPLICIT=0
if [ -n "${LLM_BIN:-}" ]; then
  LLM_BIN_EXPLICIT=1
fi
NEEDLE_CACHE=${LLM_BIN:-"${HOME}/Library/Caches/calorie-counter/needle/macos-arm64/needle"}
LOG_FILE="${TMPDIR:-/tmp}/calorie-counter-llm.log"
BONSAI_LOG="${TMPDIR:-/tmp}/calorie-counter-bonsai-${BONSAI_PORT}.log"
PROXY_LOG="${TMPDIR:-/tmp}/calorie-counter-llm-proxy.log"
# Read by the proxy's POST /models/use: it may only kill a PID it finds here,
# and only after confirming that PID still listens on the expected port.
# Namespaced by port so two bridges (the real one and the smoke test's test-port
# bridge) cannot clobber each other's ownership records.
NEEDLE_PID_FILE="${TMPDIR:-/tmp}/calorie-counter-needle-${PORT}.pid"
BONSAI_PID_FILE="${TMPDIR:-/tmp}/calorie-counter-bonsai-${BONSAI_PORT}.pid"
PROXY_PID_FILE="${TMPDIR:-/tmp}/calorie-counter-proxy-${PROXY_PORT}.pid"

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
  if [ -n "${BONSAI_API_KEY:-}" ]; then
    curl -fsS -m 5 -H "Authorization: Bearer ${BONSAI_API_KEY}" \
      "http://${HOST}:${BONSAI_PORT}/v1/models" >/dev/null 2>&1
  else
    curl -fsS -m 5 "http://${HOST}:${BONSAI_PORT}/v1/models" >/dev/null 2>&1
  fi
}

NEEDLE_URL="https://huggingface.co/Cactus-Compute/needle2/resolve/main/macos-arm64/needle"

# Fetch + verify the needle binary only (no server side effects). Shared by
# start_needle and by LLM_DOWNLOAD_ONLY=1, which the proxy shells out to for
# its needle-2 download — one implementation, one cache path, one signing step.
# Pass "force" to download even when LLM_BIN was set explicitly: the proxy's
# download route must be able to fill a path the user named, while a plain
# startup still refuses to guess when an explicit path is missing.
download_needle() {
  if [ -f "$NEEDLE_CACHE" ]; then
    return 0
  fi
  if [ "$LLM_BIN_EXPLICIT" = "1" ] && [ "${1:-}" != "force" ]; then
    echo "error: LLM_BIN=$NEEDLE_CACHE not found" >&2
    return 1
  fi
  echo "downloading needle binary (14.7 MB) to ${NEEDLE_CACHE} …"
  mkdir -p "$(dirname "$NEEDLE_CACHE")" || return 1
  curl -fsSL -o "${NEEDLE_CACHE}.part" "$NEEDLE_URL" || {
    rm -f "${NEEDLE_CACHE}.part"
    echo "error: needle binary download failed (network?). Retry on next launch." >&2
    return 1
  }
  # Upstream re-cuts this binary, so an exact byte count is a lie waiting to
  # happen — it drifted 14594024 -> 14610568 and made every fresh install
  # "fail verification" and delete a perfectly good download. Check that the
  # file is complete and is actually an arm64 Mach-O instead.
  SIZE=$(wc -c <"${NEEDLE_CACHE}.part" 2>/dev/null || echo 0)
  MAGIC=$(head -c 4 "${NEEDLE_CACHE}.part" 2>/dev/null | od -An -tx1 | tr -d ' \n')
  if [ "$SIZE" -lt 1048576 ] || [ "$MAGIC" != "cffaedfe" ]; then
    rm -f "${NEEDLE_CACHE}.part"
    echo "error: needle download failed verification (${SIZE} bytes, magic ${MAGIC}); retry on next launch" >&2
    return 1
  fi
  mv -f "${NEEDLE_CACHE}.part" "$NEEDLE_CACHE"
  chmod +x "$NEEDLE_CACHE"
  # Apple Silicon's kernel SIGKILLs unsigned arm64 executables; ad-hoc signing
  # is required for downloaded binaries.
  command -v codesign >/dev/null 2>&1 && codesign -s - "$NEEDLE_CACHE" >/dev/null 2>&1 || true
  return 0
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

  if ! download_needle; then
    return 1
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
  echo "$SERVER_PID" >"$NEEDLE_PID_FILE"

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

# Which runtime serves the Bonsai backend: the stock mlx-lm python server when
# the interpreter has it, else the oMLX server (which carries its own runtime).
# Prints "mlx_lm", "omlx" or "none".
bonsai_runner() {
  case "$BONSAI_RUNNER" in
    mlx_lm | omlx)
      echo "$BONSAI_RUNNER"
      return 0
      ;;
    auto) ;;
    *)
      echo "warning: LLM_BONSAI_RUNNER must be auto, mlx_lm or omlx (got '$BONSAI_RUNNER'); using auto" >&2
      ;;
  esac
  if "$LLM_PYTHON" -c 'import mlx_lm' >/dev/null 2>&1; then
    echo mlx_lm
  elif [ -n "$OMLX_BIN" ] && [ -x "$OMLX_BIN" ]; then
    echo omlx
  else
    echo none
  fi
}

# Token the proxy must send to the Bonsai backend. Prefers LLM_BONSAI_API_KEY;
# otherwise reuses the key oMLX already stores in its settings.json so a keyed
# `omlx serve` and the proxy agree without extra configuration.
bonsai_api_key() {
  if [ -n "${LLM_BONSAI_API_KEY:-}" ]; then
    printf '%s' "$LLM_BONSAI_API_KEY"
    return 0
  fi
  if [ -f "$OMLX_SETTINGS" ]; then
    sed -n 's/.*"api_key"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$OMLX_SETTINGS" | head -1
  fi
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
  RUNNER=$(bonsai_runner)
  case "$RUNNER" in
    mlx_lm)
      echo "starting Bonsai planner via mlx_lm.server (${BONSAI_MODEL}; first start downloads the model) …"
      nohup "$LLM_PYTHON" -m mlx_lm.server --model "$BONSAI_MODEL" --host "$HOST" --port "$BONSAI_PORT" \
        >>"$BONSAI_LOG" 2>&1 &
      ;;
    omlx)
      echo "starting Bonsai planner via oMLX (${OMLX_LIBRARY_DIR} plus the Hugging Face cache) …"
      if [ -n "${BONSAI_API_KEY:-}" ]; then
        nohup "$OMLX_BIN" serve --model-dir "$OMLX_LIBRARY_DIR" --host "$HOST" --port "$BONSAI_PORT" \
          --api-key "$BONSAI_API_KEY" >>"$BONSAI_LOG" 2>&1 &
      else
        nohup "$OMLX_BIN" serve --model-dir "$OMLX_LIBRARY_DIR" --host "$HOST" --port "$BONSAI_PORT" \
          >>"$BONSAI_LOG" 2>&1 &
      fi
      ;;
    *)
      echo "warning: no Bonsai runtime available — install mlx-lm (pip install mlx mlx-lm) or oMLX; planner disabled" >&2
      echo "       (checked LLM_PYTHON=$LLM_PYTHON and OMLX_BIN=${OMLX_BIN:-unset})" >&2
      return 0
      ;;
  esac
  SERVER_PID=$!
  echo "$SERVER_PID" >"$BONSAI_PID_FILE"
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
  # The proxy needs the same Bonsai token and the oMLX library path so its
  # probe and its model inventory agree with the servers started above.
  LLM_BONSAI_API_KEY="$BONSAI_API_KEY" OMLX_LIBRARY_DIR="$OMLX_LIBRARY_DIR" \
    nohup node "$REPO_ROOT/scripts/local-llm-proxy.mjs" >>"$PROXY_LOG" 2>&1 &
  SERVER_PID=$!
  echo "$SERVER_PID" >"$PROXY_PID_FILE"
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

BONSAI_API_KEY=$(bonsai_api_key)

# LLM_DOWNLOAD_ONLY=1 fetches artifacts and exits without starting a server.
# The proxy uses it as its default needle-2 download command, so the needle
# fetch keeps exactly one implementation (cache path, verification, signing).
if [ "${LLM_DOWNLOAD_ONLY:-0}" = "1" ]; then
  RC=0
  if want_needle; then
    download_needle force || RC=1
  fi
  exit "$RC"
fi

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
