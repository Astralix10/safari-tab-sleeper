# Safari Tab Sleeper

Safari Tab Sleeper is a Safari Web Extension with a native macOS Safari App Extension wrapper and a localhost-only memory companion.

It helps keep Safari under control when long-lived tabs, especially YouTube, Twitch, Reddit, Figma, Google Meet, or other app-like pages, keep WebKit memory alive after heavy use.

## What Is In This Repository

- `safari-tab-sleeper/`: WebExtension source, companion scripts, tests, and optional menu-bar helper.
- `safari-tab-sleeper-xcode/`: Xcode Safari App Extension wrapper used for a persistent Safari install.

## Highlights

- Sleeps inactive tabs after a configurable timeout.
- Restores sleeping tabs automatically when selected.
- Retries stuck sleeping tabs if Safari misses the first restore event.
- Keeps original tab titles and favicons visible with `[sleep]` prefixes.
- Backs up sleeping-tab restore data in a local archive.
- Compacts duplicate archived URLs so old repeated links do not grow forever.
- Cleans likely-heavy background tabs under Safari/WebKit memory pressure.
- Adds a one-click `Освободить память сейчас` popup action.
- Uses power-aware timing: faster cleanup on battery, softer cleanup on power.
- Uses normal Notification Center notifications instead of modal system dialogs.
- Builds as a Release Safari extension app through Xcode.

## Build

Run tests from the source folder:

```zsh
cd safari-tab-sleeper
npm test
npm run check:scripts
npm run build:menubar
```

Build the Safari app:

```zsh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
xcodebuild -project "safari-tab-sleeper-xcode/Safari Tab Sleeper/Safari Tab Sleeper.xcodeproj" \
  -scheme "Safari Tab Sleeper" \
  -configuration Release \
  -derivedDataPath "safari-tab-sleeper-xcode/DerivedData-Release" \
  build
```

Install locally:

```zsh
rm -rf "$HOME/Applications/Safari Tab Sleeper.app"
ditto "safari-tab-sleeper-xcode/DerivedData-Release/Build/Products/Release/Safari Tab Sleeper.app" \
  "$HOME/Applications/Safari Tab Sleeper.app"
```

Then open the app once and enable the extension in Safari Settings -> Extensions.

## Companion

Install the localhost sleep server and memory guard:

```zsh
cd safari-tab-sleeper
./companion/install-launch-agent.zsh
```

This starts:

- `com.local.safari-tab-sleeper.sleep-server`
- `com.local.safari-tab-sleeper.memory-guard`

The companion listens only on `127.0.0.1:17654`.

## Memory Model

Safari does not expose reliable per-tab memory usage to WebExtensions. This project watches Safari/WebKit process memory and swap pressure, then acts on likely-heavy background tabs. It avoids claiming exact per-tab RAM.

## License

Personal project. Add a formal license before distributing broadly.
