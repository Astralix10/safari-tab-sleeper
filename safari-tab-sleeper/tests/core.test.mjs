import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SETTINGS,
  applyProfile,
  applyPowerMode,
  buildLocalSleepPageUrl,
  buildManualSleepDecision,
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
  isKnownSleepPageUrl,
  isPressureDomain,
  isSleepPageUrl,
  makeRuntimeMessageListener,
  mergeYouTubePageState,
  normalizeAllowlist,
  normalizeRestorableUrl,
  reconcileSleepingTabsWithOpenTabs,
  setAllowlistForHost,
  shouldHealStuckSleepTab,
  shouldAutoRestoreSleepPage,
  shouldTreatYouTubeAsHighRisk,
  toggleAllowlistForHost,
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

test('mergeSettings clamps malformed values and keeps the sleep server on localhost', () => {
  const settings = mergeSettings({
    profile: 'unknown',
    inactivityMinutes: 0,
    youtubeVideoThreshold: 9999,
    youtubeHighRiskInactiveSeconds: 'not-a-number',
    aggressiveInactiveSeconds: -10,
    sleepServerUrl: 'https://evil.example/collect',
    skipPinned: 'false',
  });

  assert.equal(settings.profile, 'balanced');
  assert.equal(settings.inactivityMinutes, 1);
  assert.equal(settings.youtubeVideoThreshold, 500);
  assert.equal(settings.youtubeHighRiskInactiveSeconds, 60);
  assert.equal(settings.aggressiveInactiveSeconds, 10);
  assert.equal(settings.sleepServerUrl, DEFAULT_SETTINGS.sleepServerUrl);
  assert.equal(settings.skipPinned, true);
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

test('allowlist toggle removes the matching YouTube family without touching other sites', () => {
  assert.deepEqual(
    toggleAllowlistForHost(['www.youtube.com', '*.example.com'], 'music.youtube.com'),
    { enabled: false, allowlist: ['*.example.com'] },
  );
  assert.deepEqual(
    toggleAllowlistForHost(['*.example.com'], 'www.youtube.com'),
    { enabled: true, allowlist: ['*.example.com', 'www.youtube.com'] },
  );
});

test('explicit allowlist state is idempotent for repeated switch events', () => {
  assert.deepEqual(
    setAllowlistForHost([], 'www.youtube.com', true),
    { enabled: true, allowlist: ['www.youtube.com'] },
  );
  assert.deepEqual(
    setAllowlistForHost(['www.youtube.com'], 'www.youtube.com', true),
    { enabled: true, allowlist: ['www.youtube.com'] },
  );
  assert.deepEqual(
    setAllowlistForHost(['www.youtube.com', '*.example.com'], 'music.youtube.com', false),
    { enabled: false, allowlist: ['*.example.com'] },
  );
});

test('manual sleep cannot bypass a protected site', () => {
  const decision = buildManualSleepDecision({
    tab: {
      id: 17,
      active: true,
      audible: false,
      pinned: false,
      url: 'https://www.youtube.com/watch?v=protected',
    },
    state: { dirty: false },
    settings: { ...DEFAULT_SETTINGS, allowlist: ['youtube.com'] },
  });

  assert.deepEqual(decision, { eligible: false, reason: 'allowlisted' });
});

test('an exact rule covered by a wildcard cannot falsely report protection disabled', () => {
  assert.deepEqual(setAllowlistForHost(['app.example.com', '*.example.com'], 'app.example.com', false), {
    enabled: true, allowlist: ['app.example.com', '*.example.com'], blockedByPattern: true,
  });
});

test('balanced mode protects muted video and skips loading or already discarded pages', () => {
  for (const extra of [{ status: 'loading' }, { discarded: true }]) {
    assert.equal(buildSleepDecision({ tab: { id: 1, url: 'https://example.com', ...extra }, state: { lastActiveAt: 0 }, now: 500_000 }).sleep, false);
  }
  assert.equal(buildSleepDecision({ tab: { id: 1, url: 'https://example.com' }, state: { lastActiveAt: 0, mediaPlaying: true }, now: 500_000, sameDomainTabCount: 2 }).sleep, false);
});

test('the restore watchdog respects restoreOnFocus being disabled', () => {
  assert.equal(shouldHealStuckSleepTab({ tab: { active: true, url: buildLocalSleepPageUrl(DEFAULT_SETTINGS.sleepServerUrl, 'token') }, settings: { ...DEFAULT_SETTINGS, restoreOnFocus: false } }), false);
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
    inactivityMinutes: 5,
    youtubeHighRiskInactiveSeconds: 20,
    skipAudible: false,
  });
});

test('power-aware mode never changes the configured inactivity timer', () => {
  const balanced = mergeSettings({ profile: 'balanced' });
  const battery = applyPowerMode(balanced, { source: 'battery', ok: true });
  const power = applyPowerMode(balanced, { source: 'power', ok: true });
  const disabled = applyPowerMode({ ...balanced, powerAware: false }, { source: 'battery', ok: true });

  assert.equal(battery.powerMode, 'battery');
  assert.equal(battery.inactivityMinutes, 5);
  assert.equal(battery.youtubeHighRiskInactiveSeconds, 45);
  assert.equal(power.powerMode, 'power');
  assert.equal(power.inactivityMinutes, 5);
  assert.equal(power.youtubeHighRiskInactiveSeconds, 120);
  assert.equal(disabled.inactivityMinutes, balanced.inactivityMinutes);
  assert.equal(disabled.powerMode, 'default');
});

test('aggressive profile sleeps normal tabs at five minutes, including on power', () => {
  const now = 1_000_000;
  const settings = applyPowerMode(mergeSettings({
    profile: 'aggressive',
    inactivityMinutes: 1,
  }), { source: 'power', ok: true });
  const tab = {
    id: 19,
    active: false,
    audible: false,
    pinned: false,
    url: 'https://example.com/report',
  };

  assert.equal(settings.inactivityMinutes, 5);
  assert.deepEqual(buildSleepDecision({
    tab,
    state: { lastActiveAt: now - 299_999, dirty: false },
    settings,
    now,
  }), { sleep: false, reason: 'not-idle-long-enough' });
  assert.deepEqual(buildSleepDecision({
    tab,
    state: { lastActiveAt: now - 300_000, dirty: false },
    settings,
    now,
  }), { sleep: true, reason: 'inactive-timeout' });
});

test('aggressive profile protects the only playing media tab for a domain', () => {
  const now = 1_000_000;
  const settings = mergeSettings({ profile: 'aggressive' });
  const tab = {
    id: 20,
    active: false,
    audible: false,
    pinned: false,
    url: 'https://video.example/watch/1',
  };
  const state = {
    lastActiveAt: now - 300_000,
    dirty: false,
    mediaPlaying: true,
  };

  assert.deepEqual(buildSleepDecision({ tab, state, settings, now, sameDomainTabCount: 1 }), {
    sleep: false,
    reason: 'single-media-tab',
  });
  assert.deepEqual(buildSleepDecision({ tab, state, settings, now, sameDomainTabCount: 2 }), {
    sleep: true,
    reason: 'inactive-timeout',
  });
  assert.deepEqual(buildSleepDecision({
    tab: { ...tab, audible: true },
    state: { ...state, mediaPlaying: false },
    settings,
    now,
    sameDomainTabCount: 1,
  }), { sleep: false, reason: 'single-media-tab' });
});

test('stuck active sleep tabs are eligible for a retry healer', () => {
  const settings = mergeSettings({});
  const sleepUrl = buildLocalSleepPageUrl(settings.sleepServerUrl, 'heal-token');

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

test('YouTube navigation count survives page reloads and reset state', () => {
  assert.deepEqual(
    mergeYouTubePageState(
      { youtubeVideoCount: 25, youtubeLastVideoUrl: 'https://www.youtube.com/watch?v=a' },
      { youtubeVideoCount: 1, youtubeLastVideoUrl: 'https://www.youtube.com/watch?v=a' },
    ),
    { youtubeVideoCount: 25, youtubeLastVideoUrl: 'https://www.youtube.com/watch?v=a' },
  );
  assert.deepEqual(
    mergeYouTubePageState(
      { youtubeVideoCount: 25, youtubeLastVideoUrl: 'https://www.youtube.com/watch?v=a' },
      { youtubeVideoCount: 1, youtubeLastVideoUrl: 'https://www.youtube.com/watch?v=b' },
    ),
    { youtubeVideoCount: 26, youtubeLastVideoUrl: 'https://www.youtube.com/watch?v=b' },
  );
  assert.deepEqual(
    mergeYouTubePageState(
      { youtubeVideoCount: 0, youtubeLastVideoUrl: 'https://www.youtube.com/watch?v=b' },
      { youtubeVideoCount: 40, youtubeLastVideoUrl: 'https://www.youtube.com/watch?v=b' },
    ),
    { youtubeVideoCount: 0, youtubeLastVideoUrl: 'https://www.youtube.com/watch?v=b' },
  );
  assert.deepEqual(
    mergeYouTubePageState(
      { youtubeVideoCount: 3, youtubeLastVideoUrl: 'https://www.youtube.com/watch?v=b' },
      { youtubeVideoCount: 12, youtubeLastVideoUrl: 'https://www.youtube.com/watch?v=c' },
    ),
    { youtubeVideoCount: 12, youtubeLastVideoUrl: 'https://www.youtube.com/watch?v=c' },
  );
});

test('sleep page URLs use opaque tokens instead of leaking original URLs', () => {
  const runtimeUrl = 'safari-web-extension://example-id/';
  const token = 'abc123';
  const url = buildSleepPageUrl(runtimeUrl, token);

  assert.equal(url, 'safari-web-extension://example-id/sleep/sleep.html?token=abc123');
  assert.equal(isSleepPageUrl(url, runtimeUrl), true);
  assert.equal(url.includes('youtube.com'), false);
  assert.equal(isSleepPageUrl('safari-web-extension://foreign-id/sleep/sleep.html?token=abc123', runtimeUrl), false);
  assert.equal(isKnownSleepPageUrl(url, DEFAULT_SETTINGS, runtimeUrl), true);
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
  const url = buildLocalSleepPageUrl('http://127.0.0.1:17654/sleep', entry.token);

  assert.equal(url, 'http://127.0.0.1:17654/sleep#token=abc123');
  assert.equal(url.includes('mail.google.com'), false);
  assert.equal(isKnownSleepPageUrl(url, DEFAULT_SETTINGS), true);
  assert.deepEqual(
    buildManualSleepDecision({
      tab: { id: 1, active: true, pinned: false, audible: false, url },
      state: {},
      settings: DEFAULT_SETTINGS,
    }),
    { eligible: false, reason: 'already-sleeping' },
  );
});

test('legacy nested sleep URLs still unwrap to the original page', () => {
  const originalUrl = 'https://www.youtube.com/watch?v=original';
  const firstSleepUrl = `http://127.0.0.1:17654/sleep${encodeSleepFallback({
    token: 'first',
    url: originalUrl,
    title: 'Original video',
    sleptAt: 1,
    reason: 'memory-pressure',
  })}`;
  const nestedSleepUrl = `http://127.0.0.1:17654/sleep${encodeSleepFallback({
    token: 'second',
    url: firstSleepUrl,
    title: '[sleep] Original video',
    sleptAt: 2,
    reason: 'memory-pressure',
  })}`;

  assert.equal(normalizeRestorableUrl(nestedSleepUrl), originalUrl);

  assert.equal(
    reconcileSleepingTabsWithOpenTabs(
      {
        second: {
          token: 'second',
          tabId: 42,
          url: nestedSleepUrl,
          title: '[sleep] Original video',
        },
      },
      [{ id: 42, url: nestedSleepUrl }],
      DEFAULT_SETTINGS,
    ).second.url,
    originalUrl,
  );
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

test('restorable URL normalization never extracts a web URL from script text', () => {
  assert.equal(normalizeRestorableUrl("javascript:location='https://evil.example/'"), '');
  assert.equal(normalizeRestorableUrl('not a URL https://evil.example/'), '');
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

test('modern sleep links contain only an opaque token', () => {
  const entry = {
    token: 'abc123',
    url: 'https://www.youtube.com/watch?v=abc',
    title: 'A video',
    sleptAt: 1_000,
    reason: 'manual-current-tab',
    autoRestore: true,
  };
  const encoded = encodeSleepFallback(entry);
  const pageUrl = buildSleepPageUrl('safari-web-extension://example-id/', entry.token);

  assert.equal(pageUrl.includes('token=abc123'), true);
  assert.equal(pageUrl.includes('youtube.com'), false);
  assert.deepEqual(decodeSleepFallback(encoded), entry);
  assert.equal(new URL(pageUrl).hash, '');
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
        url: buildSleepPageUrl('safari-web-extension://example-id/', 'live-token'),
      },
      {
        id: 34,
        url: buildLocalSleepPageUrl(DEFAULT_SETTINGS.sleepServerUrl, localEntry.token),
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

test('sleeping tab icon never contacts the original site', () => {
  assert.equal(
    getSleepingTabIconUrl({
      pageUrl: 'https://www.youtube.com/watch?v=abc',
      favIconUrl: 'https://www.youtube.com/s/desktop/favicon.ico',
    }),
    '',
  );
  assert.equal(
    getSleepingTabIconUrl({
      pageUrl: 'https://www.youtube.com/watch?v=abc',
      favIconUrl: '',
    }),
    '',
  );
  const embedded = 'data:image/png;base64,AA==';
  assert.equal(getSleepingTabIconUrl({ pageUrl: 'https://example.com', favIconUrl: embedded }), embedded);
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
  assert.equal(isPressureDomain('https://youtube.com.evil.example/', DEFAULT_SETTINGS), false);
  assert.equal(isPressureDomain('https://evil.example/?next=youtube.com', DEFAULT_SETTINGS), false);
  assert.equal(isPressureDomain(buildLocalSleepPageUrl(DEFAULT_SETTINGS.sleepServerUrl, {
    token: 'sleep-token',
    url: 'https://www.youtube.com/watch?v=abc',
    title: 'Video',
  }), DEFAULT_SETTINGS), false);
  assert.equal(isPressureDomain('https://video.internal.test/', { ...DEFAULT_SETTINGS, pressureDomains: ['video.internal.test'] }), true);
});
