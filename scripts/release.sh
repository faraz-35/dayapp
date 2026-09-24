#!/usr/bin/env bash
#
# release.sh — the opinionated release. One command ships everywhere:
#
#   npm run release <patch|minor|major>            # full release
#   npm run release <patch|minor|major> dry         # build + verify only
#
# Stages (each checks current state first, so re-running after a failure
# skips what's done and resumes where it stopped — the version resumes too:
# a tagged bump commit on HEAD means "finish that release", not "roll the
# next one"):
#   1. guards     — clean tree, on main, synced with origin, tooling present
#   2. bump       — tauri.conf.json (the version source) + package.json/lock
#   3. build      — signed updater bundle + latest.json, then verified:
#                   manifest version == release version, manifest signature ==
#                   the .sig file, filenames line up
#   4. publish    — commit v<next>, tag, push
#   5. release    — gh release with .app.tar.gz + .sig + latest.json
#                   (this is the moment the in-app update channel goes live);
#                   notes auto-generated from the commits since the last tag
#   6. install    — the live curl one-liner must serve exactly this release's
#                   bytes. The site is versionless by design (install.sh
#                   downloads releases/latest/...), so a release never edits
#                   or deploys the site — it only proves the path is live
#   7. receipt    — everything printed, one line each
#
# The signing key lives in the macOS keychain (service dayapp-updater-key).
# First run imports it from the legacy file ~/.tauri/dayapp-updater.key; after
# that the keychain is the source of truth and the loose file can be lost
# without losing the channel. `dry` never writes to any repo and never
# publishes; it builds with the next version overridden and runs every gate.

set -euo pipefail

# ---- args ------------------------------------------------------------------

MODE=""
DRY_RUN=0
# `dry` (bare word) is the documented spelling: `--dry-run` is a valid npm
# flag, so `npm run release patch --dry-run` never reaches this script.
for arg in "$@"; do
  case "$arg" in
    dry|dry-run|--dry-run) DRY_RUN=1 ;;
    patch|minor|major) MODE="$arg" ;;
    *) echo "usage: npm run release <patch|minor|major> [dry]" >&2; exit 1 ;;
  esac
done
[ -n "$MODE" ] || { echo "usage: npm run release <patch|minor|major> [dry]" >&2; exit 1; }

cd "$(dirname "$0")/.."

KEY_SERVICE="dayapp-updater-key"
KEY_ACCOUNT="dayapp"
LEGACY_KEY="$HOME/.tauri/dayapp-updater.key"
SITE_URL="https://getdayapp.vercel.app"

# ---- resolve the version ---------------------------------------------------

CUR="$(python3 -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['version'])")"
# Resume rule: a release that died mid-publish leaves its bump commit as HEAD,
# tagged — re-running must finish THAT version. But a FULLY SHIPPED release
# (tag on HEAD, gh release live, channel serving it) that gets re-run is a
# request for the NEXT one, not a resume — without this, the first re-run
# after any successful release would re-ship the same version forever.
TAG_ON_HEAD=0
RESUME=0
if [ "$(git rev-parse -q --verify "refs/tags/v$CUR" 2>/dev/null || true)" = "$(git rev-parse HEAD)" ]; then
  TAG_ON_HEAD=1
fi
SHIPPED=0
if [ "$TAG_ON_HEAD" = 1 ] \
   && gh release view "v$CUR" --repo faraz-35/dayapp > /dev/null 2>&1 \
   && [ "$(curl -fsL "https://github.com/faraz-35/dayapp/releases/latest/download/latest.json" 2>/dev/null \
        | python3 -c "import json, sys; print(json.load(sys.stdin).get('version', ''))" 2>/dev/null || true)" = "$CUR" ]; then
  SHIPPED=1
fi
if [ "$TAG_ON_HEAD" = 1 ] && [ "$SHIPPED" = 0 ]; then
  NEXT="$CUR"; RESUME=1
else
  NEXT="$(MODE="$MODE" CUR="$CUR" python3 -c 'import os
c = os.environ["CUR"].split(".")
i = {"patch": 2, "minor": 1, "major": 0}[os.environ["MODE"]]
c[i] = str(int(c[i]) + 1)
for j in range(i + 1, 3): c[j] = "0"
print(".".join(c))')"
fi
TAG="v$NEXT"
PREV_TAG="$(git tag --sort=-v:refname | grep -v "^$TAG$" | head -1 || true)"

LOG_DIR="$HOME/Library/Logs/com.farazshah.dayapp"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/release-$TAG.log"
exec > >(tee -a "$LOG") 2>&1
trap 'echo "✗ release $TAG failed (line $LINENO) — fix the cause and re-run; finished stages skip themselves"' ERR

say() { echo "▸ $*"; }
die() { echo "✗ $*" >&2; exit 1; }

say "release $CUR → $TAG ($MODE)$([ "$DRY_RUN" = 1 ] && echo ', DRY RUN') — log: $LOG"

# ---- 1. guards -------------------------------------------------------------

say "guards"
for tool in gh python3 shasum; do
  command -v "$tool" > /dev/null || die "$tool not on PATH"
done
[ "$(git branch --show-current)" = "main" ] || die "not on main"
[ -z "$(git status --porcelain)" ] || die "working tree not clean"
git fetch origin --quiet
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main out of sync with origin"
if git rev-parse -q --verify "refs/tags/$TAG" > /dev/null; then
  [ "$(git rev-parse "refs/tags/$TAG")" = "$(git rev-parse HEAD)" ] \
    || die "tag $TAG already exists and points elsewhere"
  say "tag $TAG already on HEAD (resuming)"
fi

# ---- 2. bump ---------------------------------------------------------------

say "bump $CUR → $NEXT"
if [ "$DRY_RUN" = 0 ]; then
  if ! grep -q "\"version\": \"$NEXT\"" src-tauri/tauri.conf.json; then
    python3 - "$NEXT" <<'EOF'
import json, sys
v = sys.argv[1]
for path in ("src-tauri/tauri.conf.json", "package.json"):
    with open(path) as f: doc = json.load(f)
    doc["version"] = v
    with open(path, "w") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
EOF
    npm install --package-lock-only --ignore-scripts --silent
  fi
fi

# ---- 3. build + verify -----------------------------------------------------

say "key (keychain)"
if ! KEY="$(security find-generic-password -a "$KEY_ACCOUNT" -s "$KEY_SERVICE" -w 2>/dev/null)"; then
  if [ -f "$LEGACY_KEY" ]; then
    say "importing legacy key file into the keychain (prompting once)"
    security add-generic-password -a "$KEY_ACCOUNT" -s "$KEY_SERVICE" -w "$(cat "$LEGACY_KEY")"
    KEY="$(security find-generic-password -a "$KEY_ACCOUNT" -s "$KEY_SERVICE" -w)"
  else
    die "signing key nowhere: no keychain entry ($KEY_SERVICE) and no $LEGACY_KEY"
  fi
fi
KEYFILE="$(mktemp)"
trap 'rm -f "$KEYFILE" ${NOTESFILE:-} 2>/dev/null' EXIT
printf '%s' "$KEY" > "$KEYFILE"
chmod 600 "$KEYFILE"

BUNDLE="src-tauri/target/release/bundle"
TARGZ="$BUNDLE/macos/DayApp.app.tar.gz"
SIG="$TARGZ.sig"
LATEST="$BUNDLE/latest.json"

# Artifact reuse is resume-only: on a resume the source is exactly the tagged
# state, so present artifacts are the right bytes. A fresh version always
# builds — otherwise a `dry` run's leftover artifacts would let a later
# release of the same version ship stale bytes with newer commits inside.
if [ "$RESUME" = 1 ] && [ -f "$LATEST" ] && [ -f "$TARGZ" ] && [ -f "$SIG" ] && \
   [ "$(python3 -c "import json;print(json.load(open('$LATEST'))['version'])")" = "$NEXT" ]; then
  say "build — artifacts for $NEXT already present, skipping the build"
else
  say "build"
  if [ "$DRY_RUN" = 1 ]; then
    # Dry run: override the version inline instead of editing tauri.conf.json,
    # so the repo stays clean while the build itself is the real next version.
    TAURI_SIGNING_PRIVATE_KEY="$KEYFILE" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
      npx tauri build --config src-tauri/tauri.release.conf.json --bundles app \
                      --config "{\"version\":\"$NEXT\"}"
  else
    TAURI_SIGNING_PRIVATE_KEY="$KEYFILE" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
      npx tauri build --config src-tauri/tauri.release.conf.json --bundles app
  fi
  [ -f "$TARGZ" ] || die "build produced no updater bundle"
  [ -f "$SIG" ] || die "build produced no signature"

  say "manifest"
  PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  python3 - "$NEXT" "$PUB_DATE" "$SIG" "$LATEST" <<'EOF'
import json, sys
version, pub_date, sig_path, out = sys.argv[1:5]
sig = open(sig_path).read().strip()
url = f"https://github.com/faraz-35/dayapp/releases/download/v{version}/DayApp.app.tar.gz"
doc = {"version": version, "pub_date": pub_date,
       "platforms": {"darwin-aarch64": {"signature": sig, "url": url}}}
with open(out, "w") as f:
    json.dump(doc, f, indent=2)
    f.write("\n")
EOF
fi

say "verify"
[ -f "$LATEST" ] || die "no latest.json"
[ "$(python3 -c "import json;print(json.load(open('$LATEST'))['version'])")" = "$NEXT" ] \
  || die "latest.json version mismatch"
python3 - "$LATEST" "$SIG" <<'EOF'
import base64, json, sys
doc = json.load(open(sys.argv[1]))
mani = doc["platforms"]["darwin-aarch64"]["signature"]
raw = open(sys.argv[2]).read()
if mani != raw.strip(): sys.exit("latest.json signature != .sig file")
b64 = "".join(line for line in raw.splitlines() if not line.startswith("untrusted comment:"))
if b"file:DayApp.app.tar.gz" not in base64.b64decode(b64): sys.exit(".sig names the wrong file")
EOF
grep -q "v$NEXT/" "$LATEST" || die "latest.json url is not the $TAG release"
TARGZ_SHA="$(shasum -a 256 "$TARGZ" | cut -d' ' -f1)"
say "verified — tar.gz sha256 $TARGZ_SHA"

if [ "$DRY_RUN" = 1 ]; then
  say "DRY RUN — everything above is real; a full run would now publish:"
  say "  commit v$NEXT + tag $TAG, gh release v$NEXT (3 assets, notes since ${PREV_TAG:-the first tag})"
  say "  install path: the live curl one-liner must serve $TAG's bytes"
  say "DRY RUN complete — artifacts left in $BUNDLE for inspection"
  exit 0
fi

# ---- 4. publish the repo ---------------------------------------------------

if [ -n "$(git status --porcelain)" ]; then
  git add src-tauri/tauri.conf.json package.json package-lock.json
  git commit -m "v$NEXT"
  say "committed v$NEXT"
fi
if ! git rev-parse -q --verify "refs/tags/$TAG" > /dev/null; then
  git tag "$TAG"
  say "tagged $TAG"
fi
git push origin main "$TAG"
say "pushed main + $TAG"

# ---- 5. gh release ---------------------------------------------------------

NOTESFILE="$(mktemp)"
{
  echo "## Changes"
  echo
  git log "${PREV_TAG:-$TAG}"..HEAD --format='- %s' | grep -v '^- v[0-9]' || echo "- initial release"
} > "$NOTESFILE"
if gh release view "$TAG" --repo faraz-35/dayapp > /dev/null 2>&1; then
  gh release upload "$TAG" "$TARGZ" "$SIG" "$LATEST" --repo faraz-35/dayapp --clobber
  say "release $TAG updated (assets re-uploaded)"
else
  gh release create "$TAG" "$TARGZ" "$SIG" "$LATEST" \
    --repo faraz-35/dayapp --title "DayApp $TAG" --notes-file "$NOTESFILE"
  say "release $TAG created"
fi

# The gate that matters most: the endpoint every installed app polls must
# serve the new manifest. This is the updater's own fetch path, end to end —
# GitHub's asset serving can lag a release by a few seconds, hence the poll.
say "channel check"
CHANNEL_OK=0
for _ in 1 2 3 4 5 6; do
  CHANNEL_VERSION="$(curl -fsL "https://github.com/faraz-35/dayapp/releases/latest/download/latest.json" 2>/dev/null \
    | python3 -c "import json, sys; print(json.load(sys.stdin).get('version', ''))" 2>/dev/null || true)"
  if [ "$CHANNEL_VERSION" = "$NEXT" ]; then CHANNEL_OK=1; break; fi
  sleep 5
done
[ "$CHANNEL_OK" = 1 ] || die "the update channel doesn't serve $NEXT — check the release assets"
say "update channel serves $NEXT"

# ---- 6. install path --------------------------------------------------------

# The site's install story is one versionless curl one-liner: install.sh
# downloads releases/latest/download/DayApp.app.tar.gz, so a release has
# nothing to edit or deploy — the site's own sessions own its deploys. This
# gate proves the path end to end: the live script must carry the
# always-latest URL, and that URL must return exactly this release's bytes.

say "install path check"
INSTALL_OK=0
for _ in 1 2 3 4 5 6; do
  SCRIPT="$(curl -fsL "$SITE_URL/install.sh" 2>/dev/null || true)"
  URL="$(printf '%s' "$SCRIPT" | grep -o 'https://[^"]*releases/latest/download/DayApp\.app\.tar\.gz' | head -1 || true)"
  if [ -n "$URL" ]; then
    GOT_SHA="$(curl -fsL "$URL" 2>/dev/null | shasum -a 256 | cut -d' ' -f1 || true)"
    if [ "$GOT_SHA" = "$TARGZ_SHA" ]; then INSTALL_OK=1; break; fi
  fi
  sleep 10
done
[ "$INSTALL_OK" = 1 ] || die "the curl install path doesn't serve $TAG's bytes — check $SITE_URL/install.sh"
say "curl install serves $TAG"

# ---- 7. receipt ------------------------------------------------------------

NOTES_COUNT="$(grep -c '^- ' "$NOTESFILE" 2>/dev/null || echo 0)"
say "shipped $TAG:"
say "  release  https://github.com/faraz-35/dayapp/releases/tag/$TAG"
say "  channel  https://github.com/faraz-35/dayapp/releases/latest/download/latest.json (verified: serves $NEXT)"
say "  install  $SITE_URL/install.sh (verified: serves $TAG's bytes)"
say "  notes    $NOTES_COUNT changes since ${PREV_TAG:-the first tag}"
