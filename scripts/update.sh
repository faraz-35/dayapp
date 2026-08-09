#!/usr/bin/env bash
#
# update.sh — build and/or install DayApp.
#
# Two modes:
#
#   ./scripts/update.sh             # build release, swap, relaunch (default)
#   ./scripts/update.sh --swap-only # assume a build already exists; just swap + relaunch
#
# `--swap-only` is what the in-app updater calls (it runs the build itself, in
# process, so it can stream progress to the UI). The shared helpers below are
# used by both.
#
# Safe to run repeatedly. Data in ~/Library/.../dayapp.db is never touched.

set -euo pipefail

APP_ID="com.farazshah.dayapp"
APP_NAME="DayApp"
# Embed the repo root at install time so the in-app updater knows where to build
# from without any runtime config. Path is relative to this script.
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_APP="${REPO_ROOT}/src-tauri/target/release/bundle/macos/${APP_NAME}.app"
DEST_APP="/Applications/${APP_NAME}.app"
LOG_FILE="${HOME}/Library/Logs/${APP_ID}/update.log"

mkdir -p "$(dirname "$LOG_FILE")"

# Ensure node/npm are on PATH even under a detached launchd context (which starts
# with a minimal environment and wouldn't otherwise find nvm-managed node).
ensure_path() {
  if command -v npm >/dev/null 2>&1; then return; fi
  # nvm: source the nvm.sh that the user's shell normally loads.
  for candidate in \
    "${HOME}/.nvm/nvm.sh" \
    "/opt/homebrew/opt/node@22/bin" \
    "/usr/local/opt/node@22/bin" \
    "/opt/homebrew/bin" \
    "/usr/local/bin"; do
    case "$candidate" in
      *.sh) [ -f "$candidate" ] && . "$candidate" >/dev/null 2>&1 || true ;;
      *)    [ -d "$candidate" ] && PATH="${candidate}:${PATH}" ;;
    esac
  done
  export PATH
}

# Wait for all running DayApp instances to exit (graceful Apple-event quit,
# then SIGKILL). Called by the in-app path after spawning this script
# detached: the app exits, then we proceed with the swap.
wait_for_quit() {
  local running
  running="$(pgrep -f "/${APP_NAME}.app/Contents/MacOS/" || true)"
  if [ -n "$running" ]; then
    osascript -e "tell application id \"${APP_ID}\" to quit" 2>/dev/null || true
  fi
  for _ in 1 2 3 4 5 6 8 10; do
    running="$(pgrep -f "/${APP_NAME}.app/Contents/MacOS/" || true)"
    [ -z "$running" ] && return 0
    sleep 0.5
  done
  # Still alive — force.
  running="$(pgrep -f "/${APP_NAME}.app/Contents/MacOS/" || true)"
  [ -n "$running" ] && echo "$running" | xargs kill -9 2>/dev/null || true
  sleep 0.5
}

# Replace /Applications/DayApp.app with the freshly built bundle. Removing the
# old app first is required: macOS `mv dir existing-dir` nests instead of
# replacing. cp to a sibling temp so a failed copy can't leave a half-installed
# app. Clears the Gatekeeper quarantine flag along the way.
do_swap() {
  if [ ! -d "$SRC_APP" ]; then
    echo "✗ Build output not found at ${SRC_APP}" >&2
    return 1
  fi
  local tmp_dest="${DEST_APP}.new.$$"
  rm -rf "$tmp_dest"
  cp -R "$SRC_APP" "$tmp_dest"
  xattr -dr com.apple.quarantine "$tmp_dest" 2>/dev/null || true
  rm -rf "$DEST_APP"
  mv "$tmp_dest" "$DEST_APP"
  # The build also emits a .dmg; delete it so Spotlight/accidental double-click
  # can't mount it and surface the "drag to Applications" installer screen. The
  # .app bundle above is all we ever install from.
  rm -f "${REPO_ROOT}/src-tauri/target/release/bundle/dmg/${APP_NAME}"_*.dmg 2>/dev/null || true
}

# Relaunch the app and verify it actually came back. `open -a` can silently
# fail right after a bundle swap (LaunchServices hasn't re-registered it yet), so
# we re-register first, then retry a few times until the process is alive.
do_relaunch() {
  # Re-register the swapped bundle with LaunchServices so the system trusts it
  # (an adhoc-signed, freshly-copied bundle needs this or `open` may no-op).
  if [ -x /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister ]; then
    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
      -f "$DEST_APP" >/dev/null 2>&1 || true
  fi
  for _ in 1 2 3 4 5; do
    open -a "$DEST_APP" 2>/dev/null || true
    sleep 0.8
    if pgrep -f "/${APP_NAME}.app/Contents/MacOS/" >/dev/null 2>&1; then
      return 0
    fi
  done
  echo "⚠ relaunch did not confirm — app may need to be opened manually." >&2
  return 1
}

# ---- Mode dispatch ------------------------------------------------------

if [ "${1:-}" = "--swap-only" ]; then
  # Invoked by the in-app updater (detached). The app has already built and is
  # about to exit; wait for it to die, swap, relaunch. Log everything so a
  # silent failure is diagnosable later.
  {
    echo "=== swap-only run $(date) ==="
    echo "waiting for app to quit…"
    wait_for_quit
    echo "swapping…"
    do_swap
    echo "relaunching…"
    do_relaunch
    echo "=== done ==="
  } >>"$LOG_FILE" 2>&1
  exit 0
fi

# Default mode: full build + swap + relaunch (interactive CLI use).
ensure_path
cd "$REPO_ROOT"
echo "▸ Building ${APP_NAME} (release)…"
if ! npm run tauri build; then
  echo "✗ Build failed — installed app left untouched." >&2
  exit 1
fi
echo "▸ Installing to ${DEST_APP}…"
do_swap
echo "▸ Relaunching ${APP_NAME}…"
do_relaunch
echo "✓ ${APP_NAME} updated and running."
