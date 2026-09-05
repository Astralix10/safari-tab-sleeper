# Safari Tab Sleeper

Safari Tab Sleeper is a Safari Web Extension plus a small local macOS companion for reducing Safari/WebKit memory pressure.

It targets the annoying case where long-lived tabs, especially YouTube, keep large WebKit processes alive after many same-tab navigations.

## Features

- Sleeps inactive tabs after a configurable timeout.
- Uses Safe, Balanced, and Aggressive profiles.
- Keeps the selected inactivity timer stable while tuning only heavy-tab cleanup for battery or power.
- Restores sleeping tabs automatically when selected.
- Retries restore for active sleep pages that get stuck.
- Keeps the original tab title with a `[sleep]` prefix and reuses embedded favicon data when available.
- Skips active, pinned, audible, dirty-form, internal, and allowlisted tabs.
- Syncs allowlisted sites to the local companion so forced memory cleanup does not sleep protected sites such as YouTube.
- Treats YouTube allowlisting as a site family, covering `youtube.com`, subdomains, `youtu.be`, and embed/nocookie hosts.
- Tracks long YouTube sessions inside one tab and sleeps risky inactive YouTube tabs faster.
- Provides popup actions:
  - sleep current tab
  - sleep every background tab while preserving the active tab in each Safari window
  - wake all sleeping tabs
  - sleep heavy background tabs
  - free memory now
  - never sleep the current site
  - reset the YouTube counter
- Shows Safari/WebKit memory and current power mode in the popup.
- Uses a local recovery archive for sleeping-tab URLs.
- Requires a private token for localhost requests and safely follows Safari WebExtension origin rotation after app updates.
- Automatically compacts duplicate archived URLs so the archive does not grow forever.
- Rejects nested sleep-page URLs and atomically writes the recovery archive.
- Serializes tab-state updates so simultaneous Safari events cannot erase counters or restore records.
- Avoids redundant per-tab storage writes during the minute scan.
- Runs a companion monitor that silently cleans heavy background tabs around 3 GB and sends normal Notification Center alerts around 5 GB.
- Reports system swap for context but never attributes global swap to Safari or uses it alone to trigger cleanup.
- Waits for extension settings sync before the companion performs forced memory cleanup.
- Bounds companion server logs and ignores normal client disconnect noise.

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

From this directory, use the shared Xcode entrypoint:

```zsh
../script/build_and_run.sh
```

The script reuses the local companion token, synchronizes extension resources, builds Release, verifies the signature, updates the same installed bundle, installs the companion, and launches the app. The generated token file is ignored by Git. Configure your own signing team in Xcode before the first build.

Build without installing:

```zsh
../script/build_and_run.sh --build-only
```

The installed app is at `~/Applications/Safari Tab Sleeper.app`. Enable it once in Safari Settings -> Extensions. Restart Safari after an update to load the new worker; the script does not close browser windows automatically.

## Run The Companion

Install the memory guard and its self-healing localhost sleep server:

```zsh
chmod +x companion/*.zsh
./companion/install-launch-agent.zsh
```

This installs:

- `com.local.safari-tab-sleeper.memory-guard`

The memory guard starts and restarts `sleeper-server.py` when the localhost health check fails. Older standalone `com.local.safari-tab-sleeper.sleep-server` registrations are removed during installation.

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
- `/extension-state`: recent background-worker heartbeat used when SafariServices cannot report extension state.
- `/settings`: synced allowlist used by companion AppleScript cleanup.
- `/sleep-current`: returns `extension-required`; current-tab sleeping must pass the extension's live protection checks.
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

## Release 0.3.10

- Makes the aggressive profile eligible to sleep ordinary inactive tabs after five minutes, including while the Mac is charging. The next minute scan performs the operation.
- Detects playing audio and video in the page, including muted video, and protects the only media tab for a domain.
- Lets aggressive cleanup unload an inactive media tab only when another tab for the same domain is open.
- Runs the injected page-state fallback when old Safari tabs return no content-script response instead of an error.

## Release 0.3.9

- Fixes the site protection switch end to end: extension storage is authoritative and every sleep operation rechecks the latest allowlist immediately before unloading.
- Keeps the popup and companion connected when Safari rotates the WebExtension UUID after an app update.
- Routes automatic memory-pressure cleanup through the extension eligibility path, so pinned, audible, dirty, active, and protected tabs are skipped consistently.
- Prevents stale-tab navigation races, duplicate-URL targeting, orphaned archive entries, and stale tab-state growth.
- Hardens the localhost companion with Host validation, authenticated sensitive endpoints, strict settings validation, exact Safari process matching, and a single-instance lock.
- Removes original URLs and remote favicon requests from modern sleep links.

## Release 0.3.8

This release addresses the complete 0.3.7 QA report: reliable current-tab sleeping, idempotent sleep pages, exact hostname pressure matching, paired companion mutations, Release entitlements, visible native errors with a live extension-heartbeat fallback, direct power status, strict extension-origin matching, reset-ID validation, bounded logs, client-error JSON responses, numeric CLI validation, and strict restore URL parsing.

## Notes For YouTube

YouTube behaves like a single app running inside a tab. Watching many videos in one tab can leave JavaScript state, media buffers, and cached page data alive. Sleeping the tab is the most reliable public-API way to force a clean page context in Safari.
