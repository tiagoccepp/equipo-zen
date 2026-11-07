#!/bin/sh
# Build de escritorio: frontend → poda devDeps → tauri bundle → restaura.
# La poda es obligatoria: linuxdeploy (AppImage) se rompe con los binarios
# dev dentro de node_modules (esbuild estático, .node nativos) y además el
# instalador pasa de ~83MB a ~30MB. Uso: sh scripts/desktop/build.sh deb,appimage
set -eu
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
export no_proxy='*'

# linuxdeploy se distribuye como AppImage: sin FUSE solo corre extrayendo.
export APPIMAGE_EXTRACT_AND_RUN=1

BUNDLES="${1:?bundles (ej. deb,appimage)}"
shift || true
ROOT="$(dirname "$0")/../.."
cd "$ROOT"

case ":$PATH:" in
  *":$HOME/.cargo/bin:"*) ;;
  *) export PATH="$HOME/.cargo/bin:$PATH" ;;
esac
# libclang para bindgen (xcap en Linux) si está en rutas conocidas.
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
# Tauri no limpia el AppDir entre intentos: un resto de devDeps rompería linuxdeploy.
rm -rf src-tauri/target/release/bundle
# CLI pineado al lockfile: el local se podó con los devDeps.
npx --yes "@tauri-apps/cli@$CLI_VER" build --bundles "$BUNDLES" "$@"
