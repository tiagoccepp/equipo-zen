#!/bin/sh
# Desktop build: frontend → prune devDeps → tauri bundle → restore.
# Pruning is mandatory: linuxdeploy (AppImage) breaks with dev binaries
# inside node_modules (static esbuild, native .node) and the installer also
# drops from ~83MB to ~30MB. Usage: sh scripts/desktop/build.sh deb,appimage
set -eu
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
export no_proxy='*'

# linuxdeploy ships as an AppImage: without FUSE it only runs extracted.
export APPIMAGE_EXTRACT_AND_RUN=1

BUNDLES="${1:?bundles (ej. deb,appimage)}"
shift || true
ROOT="$(dirname "$0")/../.."
cd "$ROOT"

case ":$PATH:" in
  *":$HOME/.cargo/bin:"*) ;;
  *) export PATH="$HOME/.cargo/bin:$PATH" ;;
esac
# libclang for bindgen (xcap on Linux) if found in known paths.
for d in /usr/lib/llvm-*/lib; do
  if [ -f "$d/libclang.so" ]; then
    LIBCLANG_PATH="$d"
    export LIBCLANG_PATH
    break
  fi
done

npm run build
touch dist/.bundle-fresh
CLI_VER=$(node -p "require('./package-lock.json').packages['node_modules/@tauri-apps/cli'].version")

restore() {
  rm -f dist/.bundle-fresh
  npm install --no-audit --no-fund
}
trap restore EXIT INT TERM

npm prune --omit=dev
# Tauri doesn't clean the AppDir between attempts: a devDeps leftover would break linuxdeploy.
rm -rf src-tauri/target/release/bundle
# build.rs caches the frontend assets: without this, a fresh dist/ (e.g.
# sofia.html) does NOT enter the binary even if the code is fresh.
rm -rf src-tauri/target/release/build/equipo-*
# CLI pinned to the lockfile: the local one was pruned with the devDeps.
npx --yes "@tauri-apps/cli@$CLI_VER" build --bundles "$BUNDLES" "$@"
