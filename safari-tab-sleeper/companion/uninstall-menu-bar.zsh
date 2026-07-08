#!/bin/zsh
set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/com.local.safari-tab-sleeper.menubar.plist"
RUNTIME_BINARY="$HOME/Library/Application Support/Safari Tab Sleeper/SafariTabSleeperMenuBar"

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
rm -f "$PLIST" "$RUNTIME_BINARY"

echo "Removed Safari Tab Sleeper menu bar helper."
