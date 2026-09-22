#!/usr/bin/env bash
#
# release.sh — the opinionated release. One command ships everywhere:
#
#   npm run release <patch|minor|major>            # full release
#   npm run release <patch|minor|major> dry         # build + verify only
#
# Stages (each checks current state first, so re-running after a failure
# skips what's done and resumes where it stopped):
#   1. guards     — clean tree, on main, synced with origin, tooling present
#   2. bump       — tauri.conf.json (the version source) + package.json/lock
#   3. build      — signed updater bundle + dmg + latest.json, then verified:
#                   manifest version == release version, manifest signature ==
#                   the .sig file, filenames line up
#   4. publish    — commit v<next>, tag, push
#   5. release    — gh release with dmg + .app.tar.gz + .sig + latest.json
#                   (this is the moment the in-app update channel goes live);
#                   notes auto-generated from the commits since the last tag
#   6. cask       — version + sha256 in the tapped homebrew-tap, push, then
#                   brew audit + livecheck must agree with the new release
#   7. site       — the download link in dayapp-site, push, vercel --prod
#                   (retries the one-shot Not-authorized), then the live site
#                   is fetched to confirm it serves the new link
#   8. receipt    — everything printed, one line each
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

SITE="$HOME/Programming/dayapp-site"
TAP="$(brew --repo faraz-35/tap 2>/dev/null || true)"
KEY_SERVICE="dayapp-updater-key"
KEY_ACCOUNT="dayapp"
LEGACY_KEY="$HOME/.tauri/dayapp-updater.key"
SITE_URL="https://getdayapp.vercel.app"

# ---- resolve the version ---------------------------------------------------

CUR="$(python3 -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['version'])")"
NEXT="$(MODE="$MODE" CUR="$CUR" python3 -c 'import os
c = os.environ["CUR"].split(".")
i = {"patch": 2, "minor": 1, "major": 0}[os.environ["MODE"]]
c[i] = str(int(c[i]) + 1)
for j in range(i + 1, 3): c[j] = "0"
print(".".join(c))')"
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
for tool in gh vercel brew python3 shasum; do
  command -v "$tool" > /dev/null || die "$tool not on PATH"
done
[ -d "$SITE" ] || die "site repo not found at $SITE"
[ -n "$TAP" ] && [ -d "$TAP" ] || die "tap not found (brew --repo faraz-35/tap)"
[ "$(git branch --show-current)" = "main" ] || die "not on main"
[ -z "$(git status --porcelain)" ] || die "working tree not clean"
git fetch origin --quiet
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main out of sync with origin"
if git rev-parse -q --verify "refs/tags/$TAG" > /dev/null; then
  [ "$(git rev-parse "refs/tags/$TAG")" = "$(git rev-parse HEAD)" ] \
    || die "tag $TAG already exists and points elsewhere"
  say "tag $TAG already on HEAD (resuming)"
fi
if [ "$DRY_RUN" = 0 ]; then
  [ -z "$(git -C "$SITE" status --porcelain)" ] || die "site repo not clean ($SITE)"
  [ -z "$(git -C "$TAP" status --porcelain)" ] || die "tap repo not clean ($TAP)"
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
DMG="$BUNDLE/dmg/DayApp_${NEXT}_aarch64.dmg"
TARGZ="$BUNDLE/macos/DayApp.app.tar.gz"
SIG="$TARGZ.sig"
LATEST="$BUNDLE/latest.json"

if [ -f "$LATEST" ] && [ -f "$TARGZ" ] && [ -f "$SIG" ] && \
   [ "$(python3 -c "import json;print(json.load(open('$LATEST'))['version'])")" = "$NEXT" ]; then
  say "build — artifacts for $NEXT already present, skipping the build"
else
  say "build"
  if [ "$DRY_RUN" = 1 ]; then
    # Dry run: override the version inline instead of editing tauri.conf.json,
    # so the repo stays clean while the build itself is the real next version.
    TAURI_SIGNING_PRIVATE_KEY="$KEYFILE" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
      npx tauri build --config src-tauri/tauri.release.conf.json --bundles app,dmg \
                      --config "{\"version\":\"$NEXT\"}"
  else
    TAURI_SIGNING_PRIVATE_KEY="$KEYFILE" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
      npx tauri build --config src-tauri/tauri.release.conf.json --bundles app,dmg
  fi
  [ -f "$DMG" ] || die "build produced no dmg at $DMG"
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
import json, sys
doc = json.load(open(sys.argv[1]))
mani = doc["platforms"]["darwin-aarch64"]["signature"]
raw = open(sys.argv[2]).read()
if mani != raw.strip(): sys.exit("latest.json signature != .sig file")
if "file:DayApp.app.tar.gz" not in raw: sys.exit(".sig names the wrong file")
EOF
grep -q "v$NEXT/" "$LATEST" || die "latest.json url is not the $TAG release"
DMG_SHA="$(shasum -a 256 "$DMG" | cut -d' ' -f1)"
say "verified — dmg sha256 $DMG_SHA"

if [ "$DRY_RUN" = 1 ]; then
  say "DRY RUN — everything above is real; a full run would now publish:"
  say "  commit v$NEXT + tag $TAG, gh release v$NEXT (4 assets, notes since ${PREV_TAG:-the first tag})"
  say "  cask: version $NEXT + sha256 $DMG_SHA, push, audit + livecheck"
  say "  site: download link → v$NEXT, push, vercel --prod, live check"
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
  gh release upload "$TAG" "$DMG" "$TARGZ" "$SIG" "$LATEST" --repo faraz-35/dayapp --clobber
  say "release $TAG updated (assets re-uploaded)"
else
  gh release create "$TAG" "$DMG" "$TARGZ" "$SIG" "$LATEST" \
    --repo faraz-35/dayapp --title "DayApp $TAG" --notes-file "$NOTESFILE"
  say "release $TAG created — update channel is live"
fi

# ---- 6. cask ---------------------------------------------------------------

if grep -q "version \"$NEXT\"" "$TAP/Casks/dayapp.rb"; then
  say "cask already at $NEXT"
else
  python3 - "$TAP/Casks/dayapp.rb" "$NEXT" "$DMG_SHA" <<'EOF'
import re, sys
path, version, sha = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path).read()
text, n1 = re.subn(r'version "[^"]+"', f'version "{version}"', text, count=1)
text, n2 = re.subn(r'sha256 "[a-f0-9]{64}"', f'sha256 "{sha}"', text, count=1)
if n1 != 1 or n2 != 1: sys.exit("cask rewrite didn't land exactly once each")
open(path, "w").write(text)
EOF
  git -C "$TAP" add Casks/dayapp.rb
  git -C "$TAP" commit -m "dayapp $NEXT"
  git -C "$TAP" push origin main
  say "cask pushed ($NEXT)"
fi
brew audit --cask faraz-35/tap/dayapp || die "brew audit failed"
LIVECHECK="$(brew livecheck faraz-35/tap/dayapp 2>/dev/null || true)"
echo "$LIVECHECK" | grep -q "$NEXT" || die "livecheck doesn't show $NEXT: $LIVECHECK"
say "brew agrees: $LIVECHECK"

# ---- 7. site ---------------------------------------------------------------

if grep -q "v$NEXT/" "$SITE/src/App.tsx"; then
  say "site already points at v$NEXT"
else
  python3 - "$SITE/src/App.tsx" "$NEXT" <<'EOF'
import re, sys
path, version = sys.argv[1], sys.argv[2]
text = open(path).read()
new = re.sub(r"releases/download/v[\d.]+/DayApp_[\d.]+_aarch64\.dmg",
             f"releases/download/v{version}/DayApp_{version}_aarch64.dmg", text)
if new == text: sys.exit("site download link not found/changed")
open(path, "w").write(new)
EOF
  git -C "$SITE" add src/App.tsx
  git -C "$SITE" commit -m "download: v$NEXT"
  git -C "$SITE" push origin main
  say "site link pushed ($NEXT)"
fi
say "vercel deploy"
DEPLOYED=0
for attempt in 1 2 3; do
  if (cd "$SITE" && vercel deploy --prod --yes > /dev/null); then
    DEPLOYED=1
    break
  fi
  [ "$attempt" = 3 ] && die "vercel refused 3× — everything else is done; run 'vercel deploy --prod --yes' in $SITE"
  say "  attempt $attempt failed (the known Not-authorized quirk) — retrying"
  sleep 5
done
[ "$DEPLOYED" = 1 ] || die "deploy did not complete"
say "live check"
LIVE_OK=0
for _ in 1 2 3 4 5 6; do
  HTML="$(curl -fs "$SITE_URL" 2>/dev/null || true)"
  ASSET="$(echo "$HTML" | grep -o '/assets/[^"]*\.js' | head -1 || true)"
  if [ -n "$ASSET" ] && curl -fs "$SITE_URL$ASSET" 2>/dev/null | grep -q "v$NEXT/"; then
    LIVE_OK=1
    break
  fi
  sleep 10
done
[ "$LIVE_OK" = 1 ] || die "live site still doesn't serve v$NEXT — check the deployment"
say "live site serves the $NEXT download"

# ---- 8. receipt ------------------------------------------------------------

NOTES_COUNT="$(grep -c '^- ' "$NOTESFILE" 2>/dev/null || echo 0)"
say "shipped $TAG:"
say "  release  https://github.com/faraz-35/dayapp/releases/tag/$TAG"
say "  channel  https://github.com/faraz-35/dayapp/releases/latest/download/latest.json"
say "  cask     dayapp $NEXT (audit + livecheck passed)"
say "  site     $SITE_URL serves the $NEXT dmg (deployed)"
say "  dmg sha  $DMG_SHA"
say "  notes    $NOTES_COUNT changes since ${PREV_TAG:-the first tag}"
