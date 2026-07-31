#!/usr/bin/env bash
# Instala el entorno de diseño del equipo: OpenPencil (MIT, github.com/ZSeven-W/openpencil).
#
# Por qué así y no con brew: `brew install zseven-w/openpencil/op` compila desde
# fuente y falla si las Command Line Tools están viejas. Estos son los binarios
# ya compilados de la release, que no necesitan compilador.
#
# Por qué hay que sacar la cuarentena y firmar: macOS mata con SIGKILL cualquier
# binario sin firma que venga de un .dmg descargado. Sin esto el servidor
# arranca y muere sin decir por qué.

set -euo pipefail

VERSION="${OPENPENCIL_VERSION:-0.8.2}"
DESTINO="${INSTALL_DIR:-$HOME/.local/bin}"
BASE="https://github.com/ZSeven-W/openpencil/releases/download/v${VERSION}"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) CLI="op-cli-macos-aarch64.tar.gz"; DMG="OpenPencil-${VERSION}-arm64-mac.dmg" ;;
  Darwin-x86_64) CLI="op-cli-macos-x86_64.tar.gz"; DMG="OpenPencil-${VERSION}-x64-mac.dmg" ;;
  Linux-aarch64) CLI="op-cli-linux-aarch64.tar.gz"; TAR="openpencil-desktop-linux-aarch64.tar.gz" ;;
  Linux-x86_64) CLI="op-cli-linux-x86_64.tar.gz"; TAR="openpencil-desktop-linux-x86_64.tar.gz" ;;
  *) echo "Plataforma no soportada: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; [ -d "$TMP/mnt" ] && hdiutil detach -quiet "$TMP/mnt" 2>/dev/null || true' EXIT

mkdir -p "$DESTINO"

echo "→ CLI (op)"
curl -fsSL -o "$TMP/cli.tar.gz" "$BASE/$CLI"
tar -xzf "$TMP/cli.tar.gz" -C "$TMP"
install -m 755 "$TMP/op" "$DESTINO/op"

echo "→ editor (openpencil-desktop)"
if [ -n "${DMG:-}" ]; then
  curl -fsSL -o "$TMP/op.dmg" "$BASE/$DMG"
  mkdir -p "$TMP/mnt"
  hdiutil attach -nobrowse -quiet "$TMP/op.dmg" -mountpoint "$TMP/mnt"
  cp "$TMP/mnt/OpenPencil.app/Contents/MacOS/openpencil-desktop" "$DESTINO/"
  hdiutil detach -quiet "$TMP/mnt"
  chmod 755 "$DESTINO/openpencil-desktop"
  # Sin esto macOS lo mata con SIGKILL.
  xattr -cr "$DESTINO/openpencil-desktop" 2>/dev/null || true
  codesign --force --sign - "$DESTINO/openpencil-desktop" 2>/dev/null || true
else
  curl -fsSL -o "$TMP/desktop.tar.gz" "$BASE/$TAR"
  tar -xzf "$TMP/desktop.tar.gz" -C "$TMP"
  install -m 755 "$TMP/openpencil-desktop" "$DESTINO/openpencil-desktop"
fi

echo
"$DESTINO/op" --version
echo "✓ instalado en $DESTINO"
case ":$PATH:" in
  *":$DESTINO:"*) ;;
  *) echo "  Agregá $DESTINO al PATH, o definí OP_BIN=$DESTINO/op" ;;
esac
