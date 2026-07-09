#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
RUNTIME_DIR="$HOME/Library/Application Support/Safari Tab Sleeper"
PLIST="$HOME/Library/LaunchAgents/com.local.safari-tab-sleeper.memory-guard.plist"
SERVER_PLIST="$HOME/Library/LaunchAgents/com.local.safari-tab-sleeper.sleep-server.plist"
PYTHON_BIN="$(command -v python3)"

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$RUNTIME_DIR"

cp "$SCRIPT_DIR/memory-guard.zsh" "$RUNTIME_DIR/memory-guard.zsh"
cp "$SCRIPT_DIR/reload-current-tab.applescript" "$RUNTIME_DIR/reload-current-tab.applescript"
cp "$SCRIPT_DIR/sleep-current-tab.applescript" "$RUNTIME_DIR/sleep-current-tab.applescript"
cp "$SCRIPT_DIR/sleep-inactive-youtube-tabs.applescript" "$RUNTIME_DIR/sleep-inactive-youtube-tabs.applescript"
cp "$SCRIPT_DIR/sleep-all-inactive-tabs.applescript" "$RUNTIME_DIR/sleep-all-inactive-tabs.applescript"
cp "$SCRIPT_DIR/local-sleeper.html" "$RUNTIME_DIR/local-sleeper.html"
cp "$SCRIPT_DIR/sleeper-server.py" "$RUNTIME_DIR/sleeper-server.py"
chmod +x "$RUNTIME_DIR/memory-guard.zsh"
touch "$RUNTIME_DIR/allowlist.txt"

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

cat > "$SERVER_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.local.safari-tab-sleeper.sleep-server</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PYTHON_BIN</string>
    <string>$RUNTIME_DIR/sleeper-server.py</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/Library/Logs/safari-tab-sleeper-server.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/safari-tab-sleeper-server.err.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)" "$SERVER_PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$SERVER_PLIST"
launchctl enable "gui/$(id -u)/com.local.safari-tab-sleeper.sleep-server"

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/com.local.safari-tab-sleeper.memory-guard"

echo "Installed and started: $PLIST"
echo "Installed and started: $SERVER_PLIST"
