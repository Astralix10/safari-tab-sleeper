#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:---verify}"
APP_NAME="Safari Tab Sleeper"
SOURCE_DIR="$ROOT_DIR/safari-tab-sleeper"
PROJECT_DIR="$ROOT_DIR/safari-tab-sleeper-xcode/$APP_NAME"
BUILD_DIR="$ROOT_DIR/.build/DerivedData"
BUILT_APP="$BUILD_DIR/Build/Products/Release/$APP_NAME.app"
INSTALLED_APP="$HOME/Applications/$APP_NAME.app"
TOKEN_FILE="$HOME/Library/Application Support/$APP_NAME/companion-token"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

case "$MODE" in
  --build-only|--install-only|--verify|--logs|--telemetry|--debug|run) ;;
  *) echo "Usage: $0 [--build-only|--install-only|--verify|--logs|--telemetry|--debug|run]" >&2; exit 2 ;;
esac

if [[ ! -s "$TOKEN_FILE" ]]; then
  umask 077
  mkdir -p "$(dirname "$TOKEN_FILE")"
  /usr/bin/openssl rand -hex 32 > "$TOKEN_FILE"
fi
TOKEN_VALUE="$(< "$TOKEN_FILE")"
if [[ ! "$TOKEN_VALUE" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Invalid companion token; refusing to replace existing credentials." >&2
  exit 1
fi
printf "export const COMPANION_MUTATION_TOKEN = '%s';\n" "$TOKEN_VALUE" > "$SOURCE_DIR/extension/shared/companion-token.js"
unset TOKEN_VALUE
/usr/bin/rsync -a --delete "$SOURCE_DIR/extension/" "$PROJECT_DIR/$APP_NAME Extension/Resources/"

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
/usr/bin/xcodebuild -quiet -project "$PROJECT_DIR/$APP_NAME.xcodeproj" \
  -scheme "$APP_NAME" -configuration Release -derivedDataPath "$BUILD_DIR" build
/usr/bin/codesign --verify --deep --strict "$BUILT_APP"

if [[ "$MODE" == --build-only ]]; then
  echo "Built and verified: $BUILT_APP"
  exit 0
fi

/usr/bin/pkill -x "$APP_NAME" 2>/dev/null || true
mkdir -p "$HOME/Applications"
BACKUP_DIR="$(mktemp -d /tmp/safari-tab-sleeper-update.XXXXXX)"
if [[ -d "$INSTALLED_APP" ]]; then
  /usr/bin/ditto "$INSTALLED_APP" "$BACKUP_DIR/previous.app"
fi
/usr/bin/rsync -a --delete "$BUILT_APP/" "$INSTALLED_APP/"
if ! /usr/bin/codesign --verify --deep --strict "$INSTALLED_APP"; then
  if [[ -d "$BACKUP_DIR/previous.app" ]]; then
    /usr/bin/rsync -a --delete "$BACKUP_DIR/previous.app/" "$INSTALLED_APP/"
  fi
  echo "Installation verification failed. Previous bundle restored." >&2
  exit 1
fi
/bin/zsh "$SOURCE_DIR/companion/install-launch-agent.zsh"
"$LSREGISTER" -u "$BUILT_APP" 2>/dev/null || true
/usr/bin/pluginkit -r "$BUILT_APP/Contents/PlugIns/$APP_NAME Extension.appex" 2>/dev/null || true
"$LSREGISTER" -f "$INSTALLED_APP"
/usr/bin/pluginkit -a "$INSTALLED_APP/Contents/PlugIns/$APP_NAME Extension.appex"
/bin/rm -rf -- "$BACKUP_DIR"
echo "Installed: $INSTALLED_APP"

case "$MODE" in
  --install-only) exit 0 ;;
  --debug) /usr/bin/lldb -- "$INSTALLED_APP/Contents/MacOS/$APP_NAME" ;;
  --logs|--telemetry)
    /usr/bin/open "$INSTALLED_APP"
    /usr/bin/log stream --info --style compact --predicate 'process == "Safari Tab Sleeper"'
    ;;
  *)
    /usr/bin/open "$INSTALLED_APP"
    if [[ "$MODE" == --verify ]]; then /usr/bin/pgrep -x "$APP_NAME" >/dev/null; fi
    ;;
esac
