# Changelog

## 0.3.11

- Revalidate tab identity, active/pinned state, forms, media and current site protection immediately before sleep or restore.
- Durably prepare recovery records and roll them back when navigation fails.
- Preserve every live recovery token across duplicate compaction, limits and server restarts; restore all actual sleeping tabs after storage loss.
- Start inactivity at deactivation and refresh stale media state, including accessible embedded frames.
- Serialize settings edits, respect restore settings, and prevent watchdogs from immediately undoing manual sleep.
- Bound page requests and concurrent HTTP connections, reduce unchanged writes, and fix host status races.
- Authenticate privileged Safari GET requests when the browser omits Origin, restoring memory/power readings and cleanup polling without accepting ordinary website origins.
- Add executable worker integration tests and a repeatable Xcode build/install entrypoint.

## 0.2.0

- Fixed YouTube-family allowlist toggling and companion synchronization.
- Prevented ordinary websites from changing companion settings through localhost.
- Stopped treating global system swap or the companion app itself as Safari memory.
- Replaced fragile `file://` sleep navigation with the persistent localhost page.
- Added recovery for legacy, nested, Reader-mode, and expired sleep links.
- Made sleep and storage operations sequential to prevent duplicate work and lost state.
- Preserved the YouTube navigation count across reloads and reset it consistently.
- Added atomic, deduplicated archive writes with concurrent-request coverage.
- Reduced repeated scans, cleanup attempts, logging, and unchanged settings writes.
- Kept 3 GB silent cleanup and 5 GB Notification Center alert thresholds separate.

## 0.1.2

- Protected the complete YouTube domain family from companion cleanup.

## 0.1.1

- Synchronized never-sleep sites with the companion.

## 0.1.0

- Initial Safari Web Extension, Xcode wrapper, localhost sleep server, and memory guard.
