#!/bin/sh
# Strip the bundler's libwayland-* out of a built AppImage and repack it.
#
# The bundler ships the build runner's libwayland-* (wayland 1.20), and the
# AppImage's RPATH ($ORIGIN/../lib) makes that stale copy shadow the host's.
# A current Mesa (25+) binds against it, misses the wayland-1.22 symbols, and
# dies in EGL init — tauri-apps/tauri#15665. Repack without them so the
# host's copy is used: every Wayland session has it, and on X11-only boxes
# the installer's webkit2gtk-4.1 check pulls it in (libwebkit2gtk → libgtk-3
# → libwayland-client). Don't remove this — a stock repack re-breaks those
# machines.
#
# Also normalizes file modes before the repack: linuxdeploy's prebuilt
# launcher lands as 0770 root:root, which a real FUSE mount remaps away but
# a sandbox exec'ing the tree as a plain user (the AppImage catalog's test)
# hits as Permission denied.
#
# Usage: appimage-strip.sh <path-to-.AppImage>   — rewritten in place.

set -eu

img="$(readlink -f "$1")"
chmod +x "$img"
work="$(mktemp -d)"
verify="$(mktemp -d)"
trap 'rm -rf "$work" "$verify"' EXIT

(
  cd "$work"
  "$img" --appimage-extract >/dev/null
  rm -f squashfs-root/usr/lib/libwayland-*.so*
  chmod -R a+rX squashfs-root
  chmod a+x squashfs-root/AppRun squashfs-root/AppRun.wrapped
  curl -fsSL -o appimagetool \
    https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
  chmod +x appimagetool
  ARCH=x86_64 ./appimagetool --appimage-extract-and-run --comp zstd \
    squashfs-root "$img"
)

# Refuse to ship a broken strip or a regression of the mode fix: re-extract
# the repacked image and check both.
(
  cd "$verify"
  "$img" --appimage-extract >/dev/null
  leftover="$(find squashfs-root/usr/lib -name 'libwayland-*' || true)"
  if [ -n "$leftover" ]; then
    echo "::error::bundled libwayland survived the strip — refusing to ship"
    echo "$leftover"
    exit 1
  fi
  test -f squashfs-root/usr/lib/libwebkit2gtk-4.1.so.0
  test -x squashfs-root/AppRun
  test -x squashfs-root/AppRun.wrapped
  echo "clean: no bundled wayland libs, executable launchers, the host's copy will be used"
)
