import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_SETTINGS,
  buildLocalSleepPageUrl,
  mergeSettings,
  mergeYouTubePageState,
  setAllowlistForHost,
} from '../extension/background/core.js';

const execFileAsync = promisify(execFile);
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('blank numeric settings use defaults and malformed YouTube counters stay finite', () => {
  const settings = mergeSettings({
    inactivityMinutes: '',
    youtubeVideoThreshold: '',
  });
  assert.equal(settings.inactivityMinutes, DEFAULT_SETTINGS.inactivityMinutes);
  assert.equal(settings.youtubeVideoThreshold, DEFAULT_SETTINGS.youtubeVideoThreshold);

  const state = mergeYouTubePageState(
    { youtubeVideoCount: 'broken', youtubeLastVideoUrl: 'old' },
    { youtubeVideoCount: 'also-broken', youtubeLastVideoUrl: 'new' },
  );
  assert.equal(Number.isFinite(state.youtubeVideoCount), true);
  assert.equal(state.youtubeVideoCount, 1);
});

test('disabling one host never silently deletes a covering wildcard', () => {
  assert.deepEqual(
    setAllowlistForHost(['*.example.com'], 'app.example.com', false),
    { enabled: true, allowlist: ['*.example.com'], blockedByPattern: true },
  );
});

test('modern local sleep URL contains only its opaque token', () => {
  const url = buildLocalSleepPageUrl(DEFAULT_SETTINGS.sleepServerUrl, 'opaque-token');
  assert.equal(url, 'http://127.0.0.1:17654/sleep#token=opaque-token');
  assert.equal(url.includes('https://'), false);
});

test('worker resolves explicit tab IDs first and commits archive after navigation', async () => {
  const worker = await read('extension/background/service-worker-0.2.9.js');
  const queryStart = worker.indexOf('async function queryActiveTab');
  const queryEnd = worker.indexOf('async function readLivePageHint');
  const queryBody = worker.slice(queryStart, queryEnd);
  assert.equal(queryBody.includes("debugActiveTab('synthetic-hint'"), false);
  assert.equal(queryBody.indexOf('api.tabs.get(hintedTabId)') < queryBody.indexOf('api.tabs.query({})'), true);

  const sleepStart = worker.indexOf('async function performSleepTab');
  const sleepEnd = worker.indexOf('async function isTabProtectedByLatestSettings');
  const sleepBody = worker.slice(sleepStart, sleepEnd);
  assert.equal(sleepBody.includes("reason: 'tab-changed'"), true);
  assert.equal(sleepBody.indexOf('await api.tabs.update') < sleepBody.lastIndexOf('await archiveSleepEntry'), true);
  assert.equal(worker.includes("reason: 'dirty-state-unavailable'"), true);
  assert.equal(worker.includes('delete states[tabId]'), true);
});

test('page guard keeps dirty state across SPA navigation and has no one-second poll', async () => {
  const guard = await read('extension/content/page-guard.js');
  assert.equal(guard.includes('window.setInterval(handleNavigationChange, 1000)'), false);
  assert.equal(guard.includes("document.addEventListener('yt-navigate-finish'"), true);
  assert.equal(guard.includes('dirty = false;\n    if'), false);
  assert.equal(guard.includes("document.addEventListener('submit', () => {\n    dirty = true;"), true);
  assert.equal(guard.includes('Promise.resolve(api.runtime.sendMessage'), true);
});

test('companion enforces host/auth/schema and delegates automatic cleanup', async () => {
  const [server, guard, manifest] = await Promise.all([
    read('companion/sleeper-server.py'),
    read('companion/memory-guard.zsh'),
    read('extension/manifest.json').then(JSON.parse),
  ]);
  assert.equal(server.includes('def has_valid_host'), true);
  assert.equal(server.includes('X-Safari-Tab-Sleeper-Native'), true);
  assert.equal(server.includes('invalid-settings-schema'), true);
  assert.equal(server.includes('def read_cleanup_request'), true);
  assert.equal(server.includes('entries = compact_archive_entries(load_archive_entries())'), true);
  assert.equal(guard.includes('/cleanup-request'), true);
  assert.equal(guard.includes('sleep-inactive-youtube-tabs.applescript" "$SLEEP_SERVER_URL"'), false);
  assert.equal(manifest.permissions.includes('notifications'), true);
});

test('memory accounting ignores unrelated commands that mention WebKit in arguments', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'safari-tab-sleeper-process-id-'));
  const psSample = join(dir, 'ps.txt');
  const swapSample = join(dir, 'swap.txt');
  await writeFile(psSample, [
    '101 100000 /Applications/Safari.app/Contents/MacOS/Safari',
    '999 6291456 /Applications/Unrelated.app/Contents/MacOS/Unrelated --label=com.apple.WebKit.WebContent',
  ].join('\n'));
  await writeFile(swapSample, 'vm.swapusage: total = 8192.00M  used = 0.00M  free = 8192.00M\n');

  const { stdout } = await execFileAsync('zsh', [
    'companion/memory-guard.zsh', '--sample', psSample, '--swap-sample', swapSample, '--once', '--dry-run',
  ], { cwd: new URL('..', import.meta.url) });
  assert.match(stdout, /total_mb=98/);
  assert.match(stdout, /over_threshold=0/);
});

test('memory accounting includes the signed system Cryptex Safari path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'safari-tab-sleeper-cryptex-'));
  const psSample = join(dir, 'ps.txt');
  const swapSample = join(dir, 'swap.txt');
  await writeFile(psSample, [
    '101 100000 /System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app/Contents/MacOS/Safari',
    '102 200000 /System/Volumes/Preboot/Cryptexes/App/System/Library/StagedFrameworks/Safari/WebKit.framework/XPCServices/com.apple.WebKit.WebContent',
  ].join('\n'));
  await writeFile(swapSample, 'vm.swapusage: total = 8192.00M  used = 0.00M  free = 8192.00M\n');
  const { stdout } = await execFileAsync('zsh', [
    'companion/memory-guard.zsh', '--sample', psSample, '--swap-sample', swapSample, '--once', '--dry-run',
  ], { cwd: new URL('..', import.meta.url) });
  assert.match(stdout, /total_mb=293/);
});
