# Safari Tab Sleeper

Safari Tab Sleeper is a Safari Web Extension plus a small local macOS companion for reducing Safari/WebKit memory pressure.

It targets the annoying case where long-lived tabs, especially YouTube, keep large WebKit processes alive after many same-tab navigations.

## Features

- Sleeps inactive tabs after a configurable timeout.
- Uses Safe, Balanced, and Aggressive profiles.
- Applies power-aware timing: faster cleanup on battery, softer cleanup on power.
- Restores sleeping tabs automatically when selected.
- Retries restore for active sleep pages that get stuck.
- Keeps the original tab title and favicon visible with `[sleep]` prefixes.
- Skips active, pinned, audible, dirty-form, internal, and allowlisted tabs.
- Syncs allowlisted sites to the local companion so forced memory cleanup does not sleep protected sites such as YouTube.
- Treats YouTube allowlisting as a site family, covering `youtube.com`, subdomains, `youtu.be`, and embed/nocookie hosts.
- Tracks long YouTube sessions inside one tab and sleeps risky inactive YouTube tabs faster.
- Provides popup actions:
  - sleep current tab
  - sleep all except current
  - wake all sleeping tabs
  - sleep heavy background tabs
  - free memory now
  - never sleep the current site
  - reset the YouTube counter
- Shows Safari/WebKit memory and current power mode in the popup.
- Uses a local recovery archive for sleeping-tab URLs.
- Automatically compacts duplicate archived URLs so the archive does not grow forever.
- Rejects nested sleep-page URLs and atomically writes the recovery archive.
- Serializes tab-state updates so simultaneous Safari events cannot erase counters or restore records.
- Avoids redundant per-tab storage writes during the minute scan.
- Runs a companion monitor that silently cleans heavy background tabs around 3 GB and sends normal Notification Center alerts around 5 GB.
- Reports system swap for context but never attributes global swap to Safari or uses it alone to trigger cleanup.
- Waits for extension settings sync before the companion performs forced memory cleanup.

## Honest Limitation

Safari Web Extensions do not expose reliable per-tab memory usage. The extension cannot truthfully say “this tab uses 3 GB.”

The companion uses Safari/WebKit process RSS for cleanup thresholds and reports system swap only as context. It can sleep likely-heavy background domains such as YouTube, Twitch, Netflix, Google Meet, Figma, Canva, Reddit, and X/Twitter. Exact process-to-tab attribution is not promised.

## Project Layout

- `extension/`: Safari Web Extension.
- `companion/`: localhost sleep server, memory monitor, and AppleScript actions.
- `menubar/`: optional Swift/AppKit status-bar helper. It is not installed by default.
- `tests/`: Node tests for extension logic, companion parsing, and server endpoints.

The Xcode Safari App Extension wrapper lives in the sibling project:

```text
../safari-tab-sleeper-xcode/Safari Tab Sleeper/Safari Tab Sleeper.xcodeproj
```

## Build The Safari App

Release build:

```zsh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
xcodebuild -project "../safari-tab-sleeper-xcode/Safari Tab Sleeper/Safari Tab Sleeper.xcodeproj" \
  -scheme "Safari Tab Sleeper" \
  -configuration Release \
  -derivedDataPath "../safari-tab-sleeper-xcode/DerivedData-Release" \
  build
```

Install locally:

```zsh
rm -rf "$HOME/Applications/Safari Tab Sleeper.app"
ditto "../safari-tab-sleeper-xcode/DerivedData-Release/Build/Products/Release/Safari Tab Sleeper.app" \
  "$HOME/Applications/Safari Tab Sleeper.app"

/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$HOME/Applications/Safari Tab Sleeper.app"
```

Open the app once, then enable Safari Tab Sleeper in Safari Settings -> Extensions.

## Run The Companion

Install the memory guard and localhost sleep server as LaunchAgents:

```zsh
chmod +x companion/*.zsh
./companion/install-launch-agent.zsh
```

This installs:

- `com.local.safari-tab-sleeper.memory-guard`
- `com.local.safari-tab-sleeper.sleep-server`

Uninstall:

```zsh
./companion/uninstall-launch-agent.zsh
```

The companion server listens only on localhost:

```text
http://127.0.0.1:17654
```

Useful endpoints:

- `/health`: health check.
- `/memory`: Safari/WebKit memory summary.
- `/power`: battery or power-adapter status.
- `/settings`: synced allowlist used by companion AppleScript cleanup.
- `/sleep`: lightweight sleep page.
- `/archive-entry`: local backup store for sleeping-tab restore data.

## Memory Notifications

The monitor performs silent cleanup around 3 GB by default. It sends ordinary Notification Center notifications around 5 GB. It no longer opens modal system dialogs.

Tune thresholds:

```zsh
./companion/memory-guard.zsh --threshold-gb 3 --alert-threshold-gb 5
```

Dry run:

```zsh
./companion/memory-guard.zsh --once --dry-run
```

## Tests

```zsh
npm test
npm run check:scripts
npm run build:menubar
```

## Notes For YouTube

YouTube behaves like a single app running inside a tab. Watching many videos in one tab can leave JavaScript state, media buffers, and cached page data alive. Sleeping the tab is the most reliable public-API way to force a clean page context in Safari.
