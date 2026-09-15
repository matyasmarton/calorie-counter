#!/bin/sh
# Installs the clickable Calorie Counter macOS launcher as an app bundle.
#
# Usage: install-desktop-launcher.sh [DESTINATION_DIR]
#   DESTINATION_DIR  directory to place "Calorie Counter.app" in
#                    (default: ~/Applications)
#
# Never uses sudo, never installs dependencies, and never modifies global
# shell configuration. Replaces only a prior bundle with the exact same
# name in the destination; anything else in the destination is left alone.

set -u

# Repository root from this script's location, never from the caller's cwd.
REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
APP_NAME="Calorie Counter.app"
DEST_BASE=${1:-"${HOME}/Applications"}
DEST="${DEST_BASE}/${APP_NAME}"

LAUNCHER="${REPO_ROOT}/scripts/launch-desktop.sh"
WRAPPER="${REPO_ROOT}/desktop/${APP_NAME}/Contents/MacOS/Calorie Counter"
PLIST="${REPO_ROOT}/desktop/${APP_NAME}/Contents/Info.plist"

# --- Validate repository path and launcher files -------------------------
for f in "$LAUNCHER" "$WRAPPER" "$PLIST"; do
  if [ ! -f "$f" ]; then
    echo "error: required launcher file is missing: $f" >&2
    exit 1
  fi
done

# The bundle wrapper embeds the fixed repository path it execs.
EMBEDDED=$(sed -n 's|^exec "\(.*\)"$|\1|p' "$WRAPPER" | head -1)
if [ "$EMBEDDED" != "$REPO_ROOT/scripts/launch-desktop.sh" ]; then
  echo "error: bundle wrapper embeds repository path '${EMBEDDED}' but this repo is at '${REPO_ROOT}'." >&2
  echo "Update the fixed path in desktop/${APP_NAME}/Contents/MacOS/Calorie Counter, then rerun." >&2
  exit 1
fi

# --- Ensure executable bits on both shell entrypoints --------------------
chmod +x "$LAUNCHER" "$WRAPPER" || {
  echo "error: could not make launcher scripts executable." >&2
  exit 1
}

# --- Destination writability, checked before touching anything -----------
if [ ! -d "$DEST_BASE" ]; then
  if ! mkdir -p "$DEST_BASE" 2>/dev/null; then
    echo "error: destination directory is not writable: ${DEST_BASE}" >&2
    exit 1
  fi
fi
if [ ! -w "$DEST_BASE" ]; then
  echo "error: destination directory is not writable: ${DEST_BASE}" >&2
  exit 1
fi

# --- Replace only a prior bundle with this exact name ---------------------
if [ -e "$DEST" ]; then
  if [ ! -d "$DEST" ]; then
    echo "error: destination exists but is not a directory: ${DEST}" >&2
    exit 1
  fi
  rm -rf "$DEST" || {
    echo "error: could not replace existing bundle: ${DEST}" >&2
    exit 1
  }
fi

mkdir -p "${DEST}/Contents/MacOS" || {
  echo "error: could not create bundle at ${DEST}." >&2
  exit 1
}
cp "$PLIST" "${DEST}/Contents/Info.plist"
cp "$WRAPPER" "${DEST}/Contents/MacOS/Calorie Counter"
chmod +x "${DEST}/Contents/MacOS/Calorie Counter"

echo "Installed Calorie Counter launcher at ${DEST}"
