#!/bin/zsh
set -euo pipefail
setopt extendedglob

SCRIPT_DIR="${0:A:h}"
RUNTIME_DIR="$HOME/Library/Application Support/Safari Tab Sleeper"
TOKEN_FILE="$RUNTIME_DIR/companion-token"
PLIST="$HOME/Library/LaunchAgents/com.local.safari-tab-sleeper.memory-guard.plist"
SERVER_PLIST="$HOME/Library/LaunchAgents/com.local.safari-tab-sleeper.sleep-server.plist"

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$RUNTIME_DIR"

EXISTING_MUTATION_TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null || true)"
if [[ "$EXISTING_MUTATION_TOKEN" != [0-9a-f]## || ${#EXISTING_MUTATION_TOKEN} -ne 64 ]]; then
  umask 077
  /usr/bin/openssl rand -hex 32 > "$TOKEN_FILE"
fi
chmod 600 "$TOKEN_FILE"

MUTATION_TOKEN="$(cat "$TOKEN_FILE")"
write_extension_token() {
  local target="$1"
  mkdir -p "${target:h}"
  print -r -- "export const COMPANION_MUTATION_TOKEN = '$MUTATION_TOKEN';" > "$target"
}

write_extension_token "$SCRIPT_DIR/../extension/shared/companion-token.js"
XCODE_TOKEN_PATH="$SCRIPT_DIR/../../safari-tab-sleeper-xcode/Safari Tab Sleeper/Safari Tab Sleeper Extension/Resources/shared/companion-token.js"
if [[ -d "${XCODE_TOKEN_PATH:h}" ]]; then
  write_extension_token "$XCODE_TOKEN_PATH"
fi

cp "$SCRIPT_DIR/memory-guard.zsh" "$RUNTIME_DIR/memory-guard.zsh"
cp "$SCRIPT_DIR/reload-current-tab.applescript" "$RUNTIME_DIR/reload-current-tab.applescript"
cp "$SCRIPT_DIR/sleep-current-tab.applescript" "$RUNTIME_DIR/sleep-current-tab.applescript"
cp "$SCRIPT_DIR/sleep-inactive-youtube-tabs.applescript" "$RUNTIME_DIR/sleep-inactive-youtube-tabs.applescript"
cp "$SCRIPT_DIR/sleep-all-inactive-tabs.applescript" "$RUNTIME_DIR/sleep-all-inactive-tabs.applescript"
cp "$SCRIPT_DIR/local-sleeper.html" "$RUNTIME_DIR/local-sleeper.html"
cp "$SCRIPT_DIR/sleeper-server.py" "$RUNTIME_DIR/sleeper-server.py"
chmod +x "$RUNTIME_DIR/memory-guard.zsh"
if [[ ! -f "$RUNTIME_DIR/allowlist.txt" ]]; then
  touch "$RUNTIME_DIR/allowlist.txt"
  rm -f "$RUNTIME_DIR/settings-ready"
fi
# Safari may assign a new internal WebExtension origin after an app update.
# The next request must pair that origin again using the unchanged 256-bit token.
rm -f "$RUNTIME_DIR/trusted-extension-origin.txt"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.local.safari-tab-sleeper.memory-guard</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>$RUNTIME_DIR/memory-guard.zsh</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/Library/Logs/safari-tab-sleeper.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/safari-tab-sleeper.err.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)" "$SERVER_PLIST" 2>/dev/null || true
rm -f "$SERVER_PLIST"

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
/usr/bin/pkill -f "$RUNTIME_DIR/sleeper-server.py" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/com.local.safari-tab-sleeper.memory-guard"

echo "Installed and started: $PLIST"
