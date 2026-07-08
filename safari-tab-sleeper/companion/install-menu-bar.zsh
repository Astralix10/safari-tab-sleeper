#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h}"
RUNTIME_DIR="$HOME/Library/Application Support/Safari Tab Sleeper"
PLIST="$HOME/Library/LaunchAgents/com.local.safari-tab-sleeper.menubar.plist"
BINARY_NAME="SafariTabSleeperMenuBar"
BINARY_PATH="$PROJECT_DIR/menubar/.build/release/$BINARY_NAME"

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$RUNTIME_DIR"

swift build -c release --package-path "$PROJECT_DIR/menubar"

cp "$BINARY_PATH" "$RUNTIME_DIR/$BINARY_NAME"
cp "$SCRIPT_DIR/memory-guard.zsh" "$RUNTIME_DIR/memory-guard.zsh"
cp "$SCRIPT_DIR/reload-current-tab.applescript" "$RUNTIME_DIR/reload-current-tab.applescript"
cp "$SCRIPT_DIR/sleep-current-tab.applescript" "$RUNTIME_DIR/sleep-current-tab.applescript"
cp "$SCRIPT_DIR/sleep-inactive-youtube-tabs.applescript" "$RUNTIME_DIR/sleep-inactive-youtube-tabs.applescript"
cp "$SCRIPT_DIR/sleep-all-inactive-tabs.applescript" "$RUNTIME_DIR/sleep-all-inactive-tabs.applescript"
cp "$SCRIPT_DIR/local-sleeper.html" "$RUNTIME_DIR/local-sleeper.html"
chmod +x "$RUNTIME_DIR/$BINARY_NAME" "$RUNTIME_DIR/memory-guard.zsh"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.local.safari-tab-sleeper.menubar</string>
  <key>ProgramArguments</key>
  <array>
    <string>$RUNTIME_DIR/$BINARY_NAME</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/Library/Logs/safari-tab-sleeper-menubar.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/safari-tab-sleeper-menubar.err.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/com.local.safari-tab-sleeper.menubar"

echo "Installed and started: $PLIST"
