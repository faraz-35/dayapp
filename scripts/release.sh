#!/usr/bin/env bash
#
# release.sh — build the publishable release artifacts in one pass.
#
#   ./scripts/release.sh
#
# Produces, in src-tauri/target/release/bundle/:
#   dmg/macos/DayApp_<ver>_aarch64.dmg        — the cask/Homebrew artifact
#   macos/DayApp.app.tar.gz (+ .sig)          — the in-app updater bundle
#   latest.json                               — the updater manifest (version,
#                                               download URL, signature)
#
# Upload all of them to the GitHub release tagged v<version> (bump
# tauri.conf.json's version first). Tauri v2 does NOT generate latest.json —
# this script writes it from the build's own .sig, pointing the manifest's
# url at the release's DayApp.app.tar.gz. Forget to upload it and the in-app
# channel goes silent, which is why the script exists.
#
# Signs the updater bundle with the keypair at ~/.tauri/dayapp-updater.key
# (generated once via `npx tauri signer generate`). Never commit that key.
#
# A plain `npm run tauri build` (local use, npm run update) does NOT need the
# key and does NOT produce updater artifacts — signing only happens in this
# release configuration (tauri.release.conf.json).

set -euo pipefail

KEY="${HOME}/.tauri/dayapp-updater.key"
if [ ! -f "$KEY" ]; then
  echo "✗ Updater signing key not found at ${KEY}" >&2
  echo "  Generate it: npx tauri signer generate -w ${KEY} --password \"\"" >&2
  exit 1
fi
export TAURI_SIGNING_PRIVATE_KEY="$KEY"
# The keypair is passwordless; the var must exist and be empty for the signer.
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""

cd "$(dirname "$0")/.."
npx tauri build --config src-tauri/tauri.release.conf.json --bundles app,dmg

# Write the updater manifest from the build's own signature. The release tag
# must be v<version> — the url points at the tag's assets.
VERSION="$(python3 -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['version'])")"
SIG="$(cat src-tauri/target/release/bundle/macos/DayApp.app.tar.gz.sig)"
PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > src-tauri/target/release/bundle/latest.json <<EOF
{
  "version": "${VERSION}",
  "pub_date": "${PUB_DATE}",
  "platforms": {
    "darwin-aarch64": {
      "signature": "${SIG}",
      "url": "https://github.com/faraz-35/dayapp/releases/download/v${VERSION}/DayApp.app.tar.gz"
    }
  }
}
EOF

echo
echo "✓ Build complete (v${VERSION}). Upload these to the GitHub release tagged v${VERSION}:"
ls -la src-tauri/target/release/bundle/dmg/macos/*.dmg
ls -la src-tauri/target/release/bundle/macos/DayApp.app.tar.gz*
ls -la src-tauri/target/release/bundle/latest.json
