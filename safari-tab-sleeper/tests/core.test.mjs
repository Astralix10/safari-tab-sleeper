import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SETTINGS,
  applyProfile,
  applyPowerMode,
  buildLocalSleepPageUrl,
  buildSleepDecision,
  buildSleepPageUrl,
  chooseUnloadStrategy,
  decodeSleepFallback,
  encodeSleepFallback,
  formatSleepingTabTitle,
  getSleepingTabIconUrl,
  getSleepReasonTag,
  getSleepPageAutoRestoreDelay,
  isAggressiveDomain,
  isAllowlisted,
  isPressureDomain,
  isSleepPageUrl,
  makeRuntimeMessageListener,
  normalizeAllowlist,
  normalizeRestorableUrl,
  reconcileSleepingTabsWithOpenTabs,
  shouldHealStuckSleepTab,
  shouldAutoRestoreSleepPage,
  shouldTreatYouTubeAsHighRisk,
  mergeSettings,
} from '../extension/background/core.js';

test('normalizeAllowlist trims comments, schemes, paths, and empty lines', () => {
  assert.deepEqual(
    normalizeAllowlist(`
      # never sleep work dashboards
      https://app.example.com/path
      *.internal.test

      youtube.com
    `),
    ['app.example.com', '*.internal.test', 'youtube.com'],
  );
});

test('buildSleepDecision sleeps an inactive normal tab after the configured timeout', () => {
  const now = 1_000_000;
  const tab = {
    id: 7,
    active: false,
    audible: false,
    pinned: false,
    url: 'https://example.com/report',
  };
  const state = {
    lastActiveAt: now - (DEFAULT_SETTINGS.inactivityMinutes * 60_000 + 1),
    dirty: false,
    youtubeVideoCount: 0,
  };

  assert.deepEqual(buildSleepDecision({ tab, state, settings: DEFAULT_SETTINGS, now }), {
    sleep: true,
    reason: 'inactive-timeout',
  });
});

test('buildSleepDecision skips active, pinned, audible, internal, dirty, and allowlisted tabs', () => {
  const now = 1_000_000;
  const oldState = {
    lastActiveAt: 0,
    dirty: false,
    youtubeVideoCount: 0,
  };
  const baseTab = {
    id: 9,
    active: false,
    audible: false,
    pinned: false,
    url: 'https://example.com/',
  };

  assert.equal(buildSleepDecision({ tab: { ...baseTab, active: true }, state: oldState, settings: DEFAULT_SETTINGS, now }).sleep, false);
  assert.equal(buildSleepDecision({ tab: { ...baseTab, pinned: true }, state: oldState, settings: DEFAULT_SETTINGS, now }).sleep, false);
  assert.equal(buildSleepDecision({ tab: { ...baseTab, audible: true }, state: oldState, settings: DEFAULT_SETTINGS, now }).sleep, false);
  assert.equal(buildSleepDecision({ tab: { ...baseTab, url: 'about:blank' }, state: oldState, settings: DEFAULT_SETTINGS, now }).sleep, false);
  assert.equal(buildSleepDecision({ tab: baseTab, state: { ...oldState, dirty: true }, settings: DEFAULT_SETTINGS, now }).sleep, false);
  assert.equal(
    buildSleepDecision({
      tab: { ...baseTab, url: 'https://app.example.com/dashboard' },
      state: oldState,
      settings: { ...DEFAULT_SETTINGS, allowlist: ['*.example.com'] },
      now,
    }).sleep,
    false,
  );
});

test('allowlisting YouTube protects the whole YouTube site family', () => {
  const allowlist = ['www.youtube.com'];

  assert.equal(isAllowlisted('https://www.youtube.com/watch?v=1', allowlist), true);
  assert.equal(isAllowlisted('https://youtube.com/shorts/1', allowlist), true);
  assert.equal(isAllowlisted('https://music.youtube.com/watch?v=1', allowlist), true);
  assert.equal(isAllowlisted('https://m.youtube.com/watch?v=1', allowlist), true);
  assert.equal(isAllowlisted('https://youtu.be/abc', allowlist), true);
  assert.equal(isAllowlisted('https://www.youtube-nocookie.com/embed/abc', allowlist), true);
  assert.equal(isAllowlisted('https://example.com/youtube.com', allowlist), false);
});

test('profiles tune sleep timing and media behavior', () => {
  assert.deepEqual(applyProfile('safe'), {
    profile: 'safe',
    inactivityMinutes: 15,
    youtubeHighRiskInactiveSeconds: 180,
    skipAudible: true,
  });
  assert.deepEqual(applyProfile('balanced'), {
    profile: 'balanced',
    inactivityMinutes: 5,
    youtubeHighRiskInactiveSeconds: 60,
    skipAudible: true,
  });
  assert.deepEqual(applyProfile('aggressive'), {
    profile: 'aggressive',
    inactivityMinutes: 1,
    youtubeHighRiskInactiveSeconds: 20,
    skipAudible: false,
  });
});

test('power-aware mode sleeps faster on battery and softer on power', () => {
  const balanced = mergeSettings({ profile: 'balanced' });
  const battery = applyPowerMode(balanced, { source: 'battery', ok: true });
  const power = applyPowerMode(balanced, { source: 'power', ok: true });
  const disabled = applyPowerMode({ ...balanced, powerAware: false }, { source: 'battery', ok: true });

  assert.equal(battery.powerMode, 'battery');
  assert.equal(battery.inactivityMinutes, 3);
  assert.equal(battery.youtubeHighRiskInactiveSeconds, 45);
  assert.equal(power.powerMode, 'power');
  assert.equal(power.inactivityMinutes, 10);
  assert.equal(power.youtubeHighRiskInactiveSeconds, 120);
  assert.equal(disabled.inactivityMinutes, balanced.inactivityMinutes);
  assert.equal(disabled.powerMode, 'default');
});

test('stuck active sleep tabs are eligible for a retry healer', () => {
  const settings = mergeSettings({});
  const sleepUrl = buildLocalSleepPageUrl(settings.sleepServerUrl, {
    token: 'heal-token',
    url: 'https://example.com/report',
    title: 'Report',
    sleptAt: 1_000,
    reason: 'inactive-timeout',
    autoRestore: true,
  });

  assert.equal(
    shouldHealStuckSleepTab({
      tab: { id: 7, active: true, url: sleepUrl },
      settings,
      runtimeBaseUrl: 'safari-web-extension://example-id/',
    }),
    true,
  );
  assert.equal(
    shouldHealStuckSleepTab({
      tab: { id: 8, active: false, url: sleepUrl },
      settings,
      runtimeBaseUrl: 'safari-web-extension://example-id/',
    }),
    false,
  );
});

test('safe restore mode requires the local sleep server by default', () => {
  const settings = mergeSettings({});

  assert.equal(settings.requireLocalSleepServer, true);
  assert.equal(settings.sleepServerUrl, 'http://127.0.0.1:17654/sleep');
});


test('aggressive domains sleep sooner than the active profile timeout', () => {
  const now = 1_000_000;
  const tab = {
    id: 13,
    active: false,
    audible: false,
    pinned: false,
    url: 'https://www.figma.com/file/abc',
  };
  const state = {
    lastActiveAt: now - 61_000,
    dirty: false,
    youtubeVideoCount: 0,
  };
  const settings = {
    ...DEFAULT_SETTINGS,
    inactivityMinutes: 15,
    aggressiveList: ['*.figma.com'],
  };

  assert.equal(isAggressiveDomain(tab.url, settings), true);
  assert.deepEqual(buildSleepDecision({ tab, state, settings, now }), {
    sleep: true,
    reason: 'aggressive-domain',
  });
});

test('YouTube high-risk tabs can sleep earlier after many same-tab video navigations', () => {
  const now = 1_000_000;
  const tab = {
    id: 10,
    active: false,
    audible: false,
    pinned: false,
    url: 'https://www.youtube.com/',
  };
  const state = {
    lastActiveAt: now - (DEFAULT_SETTINGS.youtubeHighRiskInactiveSeconds * 1000 + 1),
    dirty: false,
    youtubeVideoCount: DEFAULT_SETTINGS.youtubeVideoThreshold,
  };

  assert.equal(shouldTreatYouTubeAsHighRisk(tab.url, state, DEFAULT_SETTINGS), true);
  assert.deepEqual(buildSleepDecision({ tab, state, settings: DEFAULT_SETTINGS, now }), {
    sleep: true,
    reason: 'youtube-smart-cleanup',
  });
});

test('sleep page URLs use opaque tokens instead of leaking original URLs', () => {
  const runtimeUrl = 'safari-web-extension://example-id/';
  const token = 'abc123';
  const url = buildSleepPageUrl(runtimeUrl, token);

  assert.equal(url, 'safari-web-extension://example-id/sleep/sleep.html?token=abc123');
  assert.equal(isSleepPageUrl(url, runtimeUrl), true);
  assert.equal(url.includes('youtube.com'), false);
});

test('local sleep server URLs survive Safari session restore without leaking the original URL plainly', () => {
  const entry = {
    token: 'abc123',
    url: 'https://mail.google.com/mail/u/0/#inbox',
    title: 'Inbox',
    sleptAt: 1_000,
    reason: 'inactive-timeout',
    autoRestore: true,
  };
  const url = buildLocalSleepPageUrl('http://127.0.0.1:17654/sleep', entry);

  assert.equal(url.startsWith('http://127.0.0.1:17654/sleep#fallback='), true);
  assert.equal(url.includes('mail.google.com'), false);
  assert.deepEqual(decodeSleepFallback(new URL(url).hash), entry);
});

test('sleep fallback restores Safari Reader URLs as normal web URLs', () => {
  const readerUrl = 'about:reader?url=https%3A%2F%2Fexample.com%2Fstory%3Fid%3D42';
  const safariReaderUrl = 'x-safari-reader://https%3A%2F%2Fnews.example.com%2Farticle';

  assert.equal(normalizeRestorableUrl(readerUrl), 'https://example.com/story?id=42');
  assert.equal(normalizeRestorableUrl(safariReaderUrl), 'https://news.example.com/article');

  const decoded = decodeSleepFallback(encodeSleepFallback({
    token: 'reader-token',
    url: readerUrl,
    title: 'Reader Story',
    sleptAt: 1_000,
    reason: 'inactive-timeout',
    autoRestore: true,
  }));

  assert.equal(decoded.url, 'https://example.com/story?id=42');
});


test('runtime message listener replies through sendResponse for callback-based Safari APIs', async () => {
  const listener = makeRuntimeMessageListener(async (message) => {
    return { ok: true, echo: message.value };
  });
  const responses = [];

  const keepsChannelOpen = listener({ value: 42 }, { tab: { id: 1 } }, (response) => {
    responses.push(response);
  });

  assert.equal(keepsChannelOpen, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(responses, [{ ok: true, echo: 42 }]);
});

test('sleep fallback survives without storage and keeps the original URL out of the query string', () => {
  const entry = {
    token: 'abc123',
    url: 'https://www.youtube.com/watch?v=abc',
    title: 'A video',
    sleptAt: 1_000,
    reason: 'manual-current-tab',
    autoRestore: true,
  };
  const encoded = encodeSleepFallback(entry);
  const pageUrl = buildSleepPageUrl('safari-web-extension://example-id/', entry.token, entry);

  assert.equal(pageUrl.includes('token=abc123'), true);
  assert.equal(pageUrl.includes('youtube.com'), false);
  assert.deepEqual(decodeSleepFallback(encoded), entry);
  assert.deepEqual(decodeSleepFallback(new URL(pageUrl).hash), entry);
});

test('sleeping tab storage is pruned to currently open sleeping tabs', () => {
  const liveEntry = {
    token: 'live-token',
    tabId: 12,
    url: 'https://www.youtube.com/watch?v=live',
    title: 'Live YouTube',
    sleptAt: 2_000,
    reason: 'inactive-timeout',
    autoRestore: true,
  };
  const localEntry = {
    token: 'local-token',
    tabId: 88,
    url: 'https://mail.google.com/mail/u/0/#inbox',
    title: 'Inbox',
    sleptAt: 3_000,
    reason: 'inactive-timeout',
    autoRestore: true,
  };
  const staleEntry = {
    token: 'stale-token',
    tabId: 99,
    url: 'https://old.example.com/',
    title: 'Old page',
    sleptAt: 1_000,
    reason: 'inactive-timeout',
    autoRestore: true,
  };

  const pruned = reconcileSleepingTabsWithOpenTabs(
    {
      'live-token': liveEntry,
      'local-token': localEntry,
      'stale-token': staleEntry,
    },
    [
      {
        id: 12,
        url: buildSleepPageUrl('safari-web-extension://example-id/', 'live-token', liveEntry),
      },
      {
        id: 34,
        url: buildLocalSleepPageUrl(DEFAULT_SETTINGS.sleepServerUrl, localEntry),
      },
      {
        id: 56,
        url: 'https://example.com/normal',
      },
    ],
    DEFAULT_SETTINGS,
    'safari-web-extension://example-id/',
  );

  assert.deepEqual(Object.keys(pruned).sort(), ['live-token', 'local-token']);
  assert.equal(pruned['live-token'].tabId, 12);
  assert.equal(pruned['local-token'].tabId, 34);
});

test('sleep page auto-restores normal slept tabs but not manually slept current tabs', () => {
  assert.equal(
    shouldAutoRestoreSleepPage({
      entry: { url: 'https://example.com/', reason: 'inactive-timeout', autoRestore: true },
      now: 3_000,
    }),
    true,
  );

  assert.equal(
    shouldAutoRestoreSleepPage({
      entry: { url: 'https://example.com/', reason: 'manual-current-tab', autoRestore: false },
      now: 3_000,
    }),
    false,
  );
});

test('sleep page auto-restore delay waits until the minimum sleep age', () => {
  assert.equal(
    getSleepPageAutoRestoreDelay({
      entry: { url: 'https://example.com/', reason: 'inactive-timeout', autoRestore: true, sleptAt: 1_000 },
      now: 1_500,
      minimumSleepMs: 1_200,
    }),
    700,
  );

  assert.equal(
    getSleepPageAutoRestoreDelay({
      entry: { url: 'https://example.com/', reason: 'inactive-timeout', autoRestore: true, sleptAt: 1_000 },
      now: 2_300,
      minimumSleepMs: 1_200,
    }),
    0,
  );

  assert.equal(
    getSleepPageAutoRestoreDelay({
      entry: { url: 'https://example.com/', reason: 'manual-current-tab', autoRestore: false, sleptAt: 1_000 },
      now: 2_300,
    }),
    null,
  );
});

test('sleeping tab title keeps the original title with a clear sleeping prefix', () => {
  assert.equal(formatSleepingTabTitle('Epic 16K 120fps Video - YouTube', 'inactive-timeout'), '[sleep: idle] Epic 16K 120fps Video - YouTube');
  assert.equal(formatSleepingTabTitle('[спит: таймер] Epic 16K 120fps Video - YouTube', 'inactive-timeout'), '[sleep: idle] Epic 16K 120fps Video - YouTube');
  assert.equal(formatSleepingTabTitle('', 'manual-all-except-current'), '[sleep: manual] Спящая вкладка');
  assert.equal(formatSleepingTabTitle('Inbox', 'sleep'), '[sleep] Inbox');
});

test('sleep reason tags are compact and stable', () => {
  assert.equal(getSleepReasonTag('inactive-timeout'), 'idle');
  assert.equal(getSleepReasonTag('youtube-smart-cleanup'), 'youtube');
  assert.equal(getSleepReasonTag('manual-youtube-cleanup'), 'youtube');
  assert.equal(getSleepReasonTag('memory-pressure'), 'memory');
  assert.equal(getSleepReasonTag('manual-all-except-current'), 'manual');
});

test('sleeping tab icon prefers original favicon and falls back to site favicon', () => {
  assert.equal(
    getSleepingTabIconUrl({
      pageUrl: 'https://www.youtube.com/watch?v=abc',
      favIconUrl: 'https://www.youtube.com/s/desktop/favicon.ico',
    }),
    'https://www.youtube.com/s/desktop/favicon.ico',
  );
  assert.equal(
    getSleepingTabIconUrl({
      pageUrl: 'https://www.youtube.com/watch?v=abc',
      favIconUrl: '',
    }),
    'https://www.youtube.com/favicon.ico',
  );
  assert.equal(
    getSleepingTabIconUrl({
      pageUrl: 'file:///tmp/local.html',
      favIconUrl: '',
    }),
    '',
  );
});

test('native tab discard is preferred when the browser supports it for background tabs', () => {
  assert.equal(
    chooseUnloadStrategy({
      tab: { id: 12, active: false },
      capabilities: { tabsDiscard: true },
      manual: false,
    }),
    'native-discard',
  );

  assert.equal(
    chooseUnloadStrategy({
      tab: { id: 12, active: true },
      capabilities: { tabsDiscard: true },
      manual: true,
    }),
    'sleep-page',
  );

  assert.equal(
    chooseUnloadStrategy({
      tab: { id: 12, active: false },
      capabilities: { tabsDiscard: false },
      manual: false,
    }),
    'sleep-page',
  );
});

test('pressure domains include common heavy web apps and support custom additions', () => {
  assert.equal(isPressureDomain('https://www.youtube.com/watch?v=abc', DEFAULT_SETTINGS), true);
  assert.equal(isPressureDomain('https://www.twitch.tv/someone', DEFAULT_SETTINGS), true);
  assert.equal(isPressureDomain('https://meet.google.com/abc-defg-hij', DEFAULT_SETTINGS), true);
  assert.equal(isPressureDomain('https://www.figma.com/file/abc', DEFAULT_SETTINGS), true);
  assert.equal(isPressureDomain('https://example.com/', DEFAULT_SETTINGS), false);
  assert.equal(isPressureDomain('https://video.internal.test/', { ...DEFAULT_SETTINGS, pressureDomains: ['video.internal.test'] }), true);
});
