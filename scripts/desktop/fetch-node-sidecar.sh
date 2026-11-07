#!/bin/sh
# Baja el binario Node 24 LTS para un triple de Tauri y lo deja en
# src-tauri/binaries/node-<triple>[.exe] (lo que pide `externalBin`).
# Uso: sh scripts/desktop/fetch-node-sidecar.sh x86_64-unknown-linux-gnu
set -eu
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
export no_proxy='*'

TRIPLE="${1:?triple de Tauri (ej. x86_64-unknown-linux-gnu)}"
OUT_DIR="$(dirname "$0")/../../src-tauri/binaries"
mkdir -p "$OUT_DIR"

case "$TRIPLE" in
  x86_64-unknown-linux-gnu) DIST=linux-x64; BIN=node ;;
  aarch64-unknown-linux-gnu) DIST=linux-arm64; BIN=node ;;
  x86_64-pc-windows-msvc) DIST=win-x64; BIN=node.exe ;;
  aarch64-pc-windows-msvc) DIST=win-arm64; BIN=node.exe ;;
  x86_64-apple-darwin) DIST=osx-x64; BIN=node ;;
  aarch64-apple-darwin) DIST=osx-arm64; BIN=node ;;
  *) echo "triple desconocido: $TRIPLE" >&2; exit 2 ;;
esac

case "$DIST" in win-*) EXT=zip ;; *) EXT=tar.gz ;; esac
VER=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/ | grep -o 'node-v[0-9][0-9.]*[0-9]' | head -n1)
test -n "$VER" || { echo "no pude resolver la versión de Node" >&2; exit 3; }
echo "Node $VER ($DIST)"

curl -fsSL -o "/tmp/$VER.$EXT" "https://nodejs.org/dist/latest-v24.x/$VER-$DIST.$EXT"
rm -rf "/tmp/$VER-$DIST"
PY=python3
command -v python3 >/dev/null 2>&1 || PY=python
case "$EXT" in
  zip) "$PY" -c "import zipfile; zipfile.ZipFile('/tmp/$VER.$EXT').extractall('/tmp')" ;;
  *) tar -xzf "/tmp/$VER.$EXT" -C /tmp ;;
esac

if [ -f "/tmp/$VER-$DIST/bin/$BIN" ]; then
  SRC="/tmp/$VER-$DIST/bin/$BIN"
else
  SRC="/tmp/$VER-$DIST/$BIN"
fi
case "$BIN" in *.exe) OUT="$OUT_DIR/equipo-node-$TRIPLE.exe" ;; *) OUT="$OUT_DIR/equipo-node-$TRIPLE" ;; esac
cp "$SRC" "$OUT"
chmod +x "$OUT"
rm -rf "/tmp/$VER-$DIST" "/tmp/$VER.$EXT"
ls -la "$OUT"
