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
- Keeps original tab titles with `[sleep]` prefixes. Embedded icons are retained; remote favicons are not fetched by sleeping tabs.
- Backs up sleeping-tab restore data in a local archive.
- Compacts duplicate archived URLs so old repeated links do not grow forever.
- Unwraps legacy and nested sleep links before restoring or archiving them.
- Serializes Safari event writes so concurrent tab updates cannot erase state.
- Syncs the never-sleep allowlist into the companion so memory-pressure cleanup respects protected sites.
- Treats a YouTube allowlist entry as the whole YouTube family, including `youtu.be` and embeds.
- Cleans likely-heavy background tabs under Safari/WebKit memory pressure.
- Waits for the extension settings sync before forced companion cleanup after install or restart.
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
./script/build_and_run.sh --build-only
```

Install locally:

```zsh
./script/build_and_run.sh --install-only
```

Then open the app once and enable the extension in Safari Settings -> Extensions.

The script reuses the existing companion token, synchronizes WebExtension resources into Xcode, builds Release, verifies signing, and updates the app at `~/Applications/Safari Tab Sleeper.app`. Without flags it also opens the host app. It never quits Safari automatically. Restart Safari after an update to load its new background worker.

If an Xcode update reports incompatible developer frameworks, run the official `xcodebuild -runFirstLaunch` setup before building.

## Release 0.3.11

This release fixes sleep/restore races, media protection in embedded frames, simultaneous allowlist edits, stale playback state, and recovery records deleted while tabs were still open. It includes executable worker integration tests. See [the audit report](AUDIT-2026-09-05.md).

The aggressive profile waits five minutes after leaving a tab. A one-minute alarm checks due tabs; browser scheduling or a sleeping Mac may delay execution. Active, pinned, protected and unsaved-data tabs are excluded. A playing media tab is protected when it is the only loaded tab for its domain.

## Companion

Install the memory guard with its self-healing localhost sleep server:

```zsh
cd safari-tab-sleeper
./companion/install-launch-agent.zsh
```

This starts one persistent LaunchAgent:

- `com.local.safari-tab-sleeper.memory-guard`

The monitor starts and restarts the companion server as needed. The companion listens only on `127.0.0.1:17654`.

## Memory Model

Safari does not expose reliable per-tab memory usage to WebExtensions. This project uses Safari/WebKit process RSS for cleanup decisions and displays system swap only as context. It acts on likely-heavy background tabs without claiming exact per-tab RAM.

## License

Personal project. Add a formal license before distributing broadly.
