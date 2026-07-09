# Safari Tab Sleeper Release Notes

## 0.1.2

- Treat `www.youtube.com` in `Не усыплять сайт` as protection for the YouTube family: `youtube.com`, `*.youtube.com`, `youtu.be`, and YouTube embed/nocookie hosts.
- Expanded the companion allowlist sync so AppleScript cleanup receives the same YouTube protection.
- Prevented companion AppleScript cleanup from re-sleeping existing localhost or extension sleep pages.
- Reset the companion settings-ready marker during install so upgrades wait for a fresh extension settings sync.

## 0.1.1

- Fixed companion memory cleanup ignoring the extension's `Не усыплять сайт` allowlist.
- Synced allowlisted domains to the localhost companion through `/settings`.
- Updated AppleScript cleanup paths to skip allowlisted hosts before sleeping heavy or background tabs.
- Made the memory guard wait for first extension settings sync before forced cleanup, preventing startup races.
- Added regression tests for allowlist sync and companion cleanup behavior.

## 0.1.0

- Added automatic stuck sleep-tab healing.
- Added local restore archive for sleep entries.
- Added duplicate archive cleanup by URL.
- Added battery/power-aware sleep timing.
- Added `Освободить память сейчас` popup action.
- Switched memory alerts from modal dialogs to normal Notification Center notifications.
- Switched local install flow to a Release Xcode build.
- Added tests for core sleep behavior, archive endpoints, power status, popup UI, and memory guard notification behavior.
