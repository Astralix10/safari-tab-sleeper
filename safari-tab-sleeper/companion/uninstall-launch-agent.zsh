#!/bin/zsh
set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/com.local.safari-tab-sleeper.memory-guard.plist"
SERVER_PLIST="$HOME/Library/LaunchAgents/com.local.safari-tab-sleeper.sleep-server.plist"
RUNTIME_DIR="$HOME/Library/Application Support/Safari Tab Sleeper"

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootout "gui/$(id -u)" "$SERVER_PLIST" 2>/dev/null || true
rm -f "$PLIST" "$SERVER_PLIST"
rm -rf "$RUNTIME_DIR"

echo "Removed Safari Tab Sleeper companion LaunchAgents."
