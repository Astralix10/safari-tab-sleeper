import {
  DEFAULT_SETTINGS,
  applyPowerMode,
  applyProfile,
  buildLocalSleepPageUrl,
  buildManualSleepDecision,
  buildSleepDecision,
  buildSleepPageUrl,
  chooseUnloadStrategy,
  extractLocalSleepToken,
  extractSleepToken,
  formatReason,
  hostnameFromUrl,
  isPressureDomain,
  isYouTubeUrl,
  makeSleepToken,
  makeRuntimeMessageListener,
  mergeYouTubePageState,
  mergeSettings,
  normalizeRestorableUrl,
  reconcileSleepingTabsWithOpenTabs,
  shouldHealStuckSleepTab,
  shouldTreatYouTubeAsHighRisk,
  toggleAllowlistForHost,
} from './core.js';

const api = globalThis.browser ?? globalThis.chrome;
const RUNTIME_BASE_URL = api.runtime.getURL('/');
const SCAN_ALARM = 'tab-sleeper-scan';
const STORAGE_KEYS = {
  settings: 'settings',
  tabStates: 'tabStates',
  sleepingTabs: 'sleepingTabs',
  notificationState: 'notificationState',
};
const AUTO_RESTORE_REASONS = new Set([
  'inactive-timeout',
  'youtube-smart-cleanup',
  'aggressive-domain',
  'memory-pressure',
  'memory-guard',
  'manual-memory-cleanup',
  'manual-youtube-cleanup',
  'manual-all-except-current',
]);
const pendingSleepHeals = new Set();
const pendingTabSleeps = new Set();
const storageMutationQueues = new Map();
let sleepQueue = Promise.resolve();
let scanInFlight = null;

async function readSettings() {
  const result = await api.storage.local.get(STORAGE_KEYS.settings);
  return mergeSettings(result[STORAGE_KEYS.settings] ?? DEFAULT_SETTINGS);
}

async function writeSettings(settings) {
  const mergedSettings = mergeSettings(settings);
  await api.storage.local.set({
    [STORAGE_KEYS.settings]: mergedSettings,
  });
  await syncCompanionSettings(mergedSettings);
}

async function readObject(key) {
  await (storageMutationQueues.get(key) ?? Promise.resolve());
  return readObjectImmediately(key);
}

async function readObjectImmediately(key) {
  const result = await api.storage.local.get(key);
  return result[key] ?? {};
}

function mutateObject(key, mutator) {
  const previous = storageMutationQueues.get(key) ?? Promise.resolve();
  const operation = previous.then(async () => {
    const value = await readObjectImmediately(key);
    const result = await mutator(value);
    await api.storage.local.set({ [key]: value });
    return result;
  });
  const settled = operation.catch(() => undefined);
  storageMutationQueues.set(key, settled);
  void settled.finally(() => {
    if (storageMutationQueues.get(key) === settled) {
      storageMutationQueues.delete(key);
    }
  });
  return operation;
}

async function patchTabState(tabId, patch) {
  return mutateObject(STORAGE_KEYS.tabStates, (states) => {
    const key = String(tabId);
    const compactPatch = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    states[key] = {
      ...(states[key] ?? {}),
      ...compactPatch,
      updatedAt: Date.now(),
    };
    return states[key];
  });
}

async function getTabState(tabId) {
  const states = await readObject(STORAGE_KEYS.tabStates);
  return states[String(tabId)] ?? {};
}

async function ensureTabState(tab, knownState = null) {
  const state = knownState ?? await getTabState(tab.id);
  const now = Date.now();

  if (state.createdAt) {
    const patch = {};
    if (tab.title !== state.title) patch.title = tab.title;
    if (tab.url !== state.url) patch.url = tab.url;
    if (tab.favIconUrl !== state.favIconUrl) patch.favIconUrl = tab.favIconUrl;
    if (tab.active) patch.lastActiveAt = now;
    return Object.keys(patch).length > 0 ? patchTabState(tab.id, patch) : state;
  }

  return mutateObject(STORAGE_KEYS.tabStates, (states) => {
    const key = String(tab.id);
    const current = states[key] ?? {};
    states[key] = {
      createdAt: now,
      lastActiveAt: now,
      dirty: false,
      youtubeVideoCount: 0,
      ...current,
      title: tab.title,
      url: tab.url,
      favIconUrl: tab.favIconUrl,
      lastActiveAt: tab.active ? now : (current.lastActiveAt ?? now),
      updatedAt: now,
    };
    return states[key];
  });
}

async function askPageCanSleep(tab, settings, state) {
  if (!settings.protectDirtyForms) {
    return { canSleep: true };
  }

  try {
    const response = await api.tabs.sendMessage(tab.id, { type: 'tab-sleeper:can-sleep' });
    if (response && typeof response === 'object') {
      const youtubeState = mergeYouTubePageState(state, response);
      await patchTabState(tab.id, {
        dirty: Boolean(response.dirty),
        ...youtubeState,
      });
      return {
        canSleep: response.canSleep !== false,
        dirty: Boolean(response.dirty),
      };
    }
  } catch {
    return { canSleep: true, missingContentScript: true };
  }

  return { canSleep: true };
}

async function notifyOnce(id, title, message) {
  if (!api.notifications?.create) {
    return;
  }

  try {
    const now = Date.now();
    const shouldNotify = await mutateObject(STORAGE_KEYS.notificationState, (notificationState) => {
      const previous = notificationState[id] ?? 0;
      if (now - previous < 30 * 60_000) {
        return false;
      }
      notificationState[id] = now;
      return true;
    });
    if (!shouldNotify) {
      return;
    }
    await api.notifications.create(id, {
      type: 'basic',
      iconUrl: api.runtime.getURL('icons/icon-128.svg'),
      title,
      message,
    });
  } catch {
    // Notifications are best-effort. Safari permissions vary by version.
  }
}

async function isLocalSleepServerAvailable(settings) {
  try {
    const healthUrl = new URL(settings.sleepServerUrl || DEFAULT_SETTINGS.sleepServerUrl);
    healthUrl.pathname = '/health';
    healthUrl.search = '';
    healthUrl.hash = '';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 450);
    try {
      const response = await fetch(healthUrl.toString(), {
        cache: 'no-store',
        signal: controller.signal,
      });
      return response.ok;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}

function localServerEndpoint(settings, pathname) {
  const url = new URL(settings.sleepServerUrl || DEFAULT_SETTINGS.sleepServerUrl);
  url.pathname = pathname;
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function readLocalJson(settings, pathname, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 700);
  try {
    const response = await fetch(localServerEndpoint(settings, pathname), {
      cache: 'no-store',
      signal: controller.signal,
      ...options.fetchOptions,
    });
    if (!response.ok) {
      return null;
    }
    return response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function readPowerStatus(settings) {
  return (await readLocalJson(settings, '/power')) ?? {
    ok: false,
    source: 'unknown',
    label: 'Питание: неизвестно',
  };
}

async function readRuntimeSettings() {
  const baseSettings = await readSettings();
  await syncCompanionSettings(baseSettings);
  const powerStatus = await readPowerStatus(baseSettings);
  return {
    baseSettings,
    settings: applyPowerMode(baseSettings, powerStatus),
    powerStatus,
  };
}

async function archiveSleepEntry(settings, entry) {
  await readLocalJson(settings, '/archive-entry', {
    timeoutMs: 900,
    fetchOptions: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entry }),
    },
  });
}

async function syncCompanionSettings(settings) {
  await readLocalJson(settings, '/settings', {
    timeoutMs: 700,
    fetchOptions: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        allowlist: settings.allowlist ?? [],
        pressureDomains: settings.pressureDomains ?? [],
      }),
    },
  });
}

async function readArchivedSleepEntry(settings, token) {
  try {
    const url = new URL(localServerEndpoint(settings, '/archive-entry'));
    url.searchParams.set('token', token);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 700);
    try {
      const response = await fetch(url.toString(), {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        return null;
      }
      return (await response.json())?.entry ?? null;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null;
  }
}

async function buildSleepNavigationUrl(settings, token, sleepEntry) {
  if (await isLocalSleepServerAvailable(settings)) {
    return buildLocalSleepPageUrl(settings.sleepServerUrl || DEFAULT_SETTINGS.sleepServerUrl, sleepEntry);
  }

  if (settings.requireLocalSleepServer) {
    return null;
  }

  return buildSleepPageUrl(RUNTIME_BASE_URL, token, sleepEntry);
}

function extractKnownSleepToken(tabUrl, settings) {
  const extensionToken = extractSleepToken(tabUrl, RUNTIME_BASE_URL);
  if (extensionToken) {
    return extensionToken;
  }

  return extractLocalSleepToken(tabUrl, settings.sleepServerUrl || DEFAULT_SETTINGS.sleepServerUrl);
}

function sleepTab(tab, reason, options = {}) {
  if (!tab?.id) {
    return Promise.resolve({ ok: false, reason: 'missing-tab' });
  }
  if (pendingTabSleeps.has(tab.id)) {
    return Promise.resolve({ ok: false, reason: 'sleep-already-in-progress' });
  }

  pendingTabSleeps.add(tab.id);
  const operation = sleepQueue.then(() => performSleepTab(tab, reason, options));
  sleepQueue = operation.catch(() => undefined);
  return operation.finally(() => {
    pendingTabSleeps.delete(tab.id);
  });
}

async function rollbackSleepPreparation(tabId, token) {
  await mutateObject(STORAGE_KEYS.sleepingTabs, (sleepingTabs) => {
    delete sleepingTabs[token];
  });
  await patchTabState(tabId, {
    sleepToken: null,
    sleptAt: null,
    sleepStrategy: null,
  });
}

async function performSleepTab(tab, reason, options = {}) {
  const settings = options.settings ?? (await readRuntimeSettings()).settings;
  const state = await ensureTabState(tab);
  const guard = await askPageCanSleep(tab, settings, state);

  if (!guard.canSleep && !options.forceDirty) {
    return { ok: false, reason: 'dirty-form' };
  }

  const decision = options.manual
    ? buildManualSleepDecision({ tab, state: { ...state, dirty: guard.dirty }, settings, runtimeBaseUrl: RUNTIME_BASE_URL })
    : buildSleepDecision({ tab, state: { ...state, dirty: guard.dirty }, settings, runtimeBaseUrl: RUNTIME_BASE_URL });

  if (options.manual ? !decision.eligible : !decision.sleep) {
    return { ok: false, reason: decision.reason };
  }

  const token = makeSleepToken();
  const restorableUrl = normalizeRestorableUrl(tab.url);
  if (!restorableUrl) {
    return { ok: false, reason: 'unrestorable-url' };
  }

  const sleptAt = Date.now();
  const sleepEntry = {
    token,
    tabId: tab.id,
    url: restorableUrl,
    title: tab.title || tab.url,
    favIconUrl: tab.favIconUrl || '',
    sleptAt,
    reason,
    autoRestore: AUTO_RESTORE_REASONS.has(reason),
  };
  await mutateObject(STORAGE_KEYS.sleepingTabs, (sleepingTabs) => {
    sleepingTabs[token] = sleepEntry;
  });
  await archiveSleepEntry(settings, sleepEntry);
  await patchTabState(tab.id, {
    sleepToken: token,
    sleptAt,
    dirty: false,
  });

  const strategy = chooseUnloadStrategy({
    tab,
    capabilities: { tabsDiscard: typeof api.tabs.discard === 'function' },
    manual: Boolean(options.manual),
  });

  if (strategy === 'native-discard') {
    try {
      await api.tabs.discard(tab.id);
      await patchTabState(tab.id, {
        sleepStrategy: 'native-discard',
      });
      return { ok: true, token, reason, strategy };
    } catch {
      await patchTabState(tab.id, {
        sleepStrategy: 'sleep-page-fallback',
      });
    }
  }

  const sleepUrl = await buildSleepNavigationUrl(settings, token, sleepEntry);
  if (!sleepUrl) {
    await rollbackSleepPreparation(tab.id, token);
    return { ok: false, reason: 'sleep-server-unavailable' };
  }

  try {
    await api.tabs.update(tab.id, { url: sleepUrl });
  } catch {
    await rollbackSleepPreparation(tab.id, token);
    return { ok: false, reason: 'sleep-navigation-failed' };
  }
  return { ok: true, token, reason, strategy: 'sleep-page' };
}

async function restoreSleepingTab(tabId, token) {
  const settings = await readSettings();
  const sleepingTabs = await readObject(STORAGE_KEYS.sleepingTabs);
  const entry = sleepingTabs[token] ?? await readArchivedSleepEntry(settings, token);
  const restorableUrl = normalizeRestorableUrl(entry?.url);
  if (!restorableUrl) {
    return { ok: false, reason: 'missing-sleep-entry' };
  }

  await api.tabs.update(tabId, { url: restorableUrl });
  await mutateObject(STORAGE_KEYS.sleepingTabs, (currentSleepingTabs) => {
    delete currentSleepingTabs[token];
  });
  await patchTabState(tabId, {
    lastActiveAt: Date.now(),
    sleepToken: null,
    restoredAt: Date.now(),
  });

  return { ok: true, url: restorableUrl };
}

async function maybeRestoreOnFocus(tab) {
  const { settings } = await readRuntimeSettings();
  if (!settings.restoreOnFocus || !tab?.url) {
    return;
  }

  const token = extractKnownSleepToken(tab.url, settings);
  if (token) {
    const result = await restoreSleepingTab(tab.id, token);
    if (!result?.ok) {
      scheduleStuckSleepHeal(tab, settings);
    }
  }
}

function scheduleStuckSleepHeal(tab, settings) {
  if (!shouldHealStuckSleepTab({ tab, settings, runtimeBaseUrl: RUNTIME_BASE_URL })) {
    return;
  }

  const token = extractKnownSleepToken(tab.url, settings);
  const key = `${tab.id}:${token}`;
  if (!token || pendingSleepHeals.has(key)) {
    return;
  }

  pendingSleepHeals.add(key);
  setTimeout(async () => {
    try {
      const currentTab = await api.tabs.get(tab.id);
      if (
        currentTab?.active
        && shouldHealStuckSleepTab({ tab: currentTab, settings, runtimeBaseUrl: RUNTIME_BASE_URL })
        && extractKnownSleepToken(currentTab.url, settings) === token
      ) {
        await restoreSleepingTab(currentTab.id, token);
      }
    } catch {
      // The tab may have closed before the retry.
    } finally {
      pendingSleepHeals.delete(key);
    }
  }, 1800);
}

async function markTabActive(tabId) {
  try {
    const tab = await api.tabs.get(tabId);
    await patchTabState(tabId, {
      lastActiveAt: Date.now(),
      title: tab.title,
      url: tab.url,
      favIconUrl: tab.favIconUrl,
    });
    await maybeRestoreOnFocus(tab);
  } catch {
    // Tab may have disappeared.
  }
}

async function performTabScan() {
  const { settings } = await readRuntimeSettings();
  const [tabs, knownStates] = await Promise.all([
    api.tabs.query({}),
    readObject(STORAGE_KEYS.tabStates),
  ]);

  for (const tab of tabs) {
    try {
      if (!tab.id || !tab.url) {
        continue;
      }

      const state = await ensureTabState(tab, knownStates[String(tab.id)] ?? {});

      if (tab.active) {
        scheduleStuckSleepHeal(tab, settings);
        if (shouldTreatYouTubeAsHighRisk(tab.url, state, settings)) {
          await notifyOnce(
            `youtube-risk-${tab.id}`,
            'YouTube-вкладка тяжелеет',
            `В этой вкладке уже ${state.youtubeVideoCount} переходов по видео. Когда закончишь, усыпи её через попап.`,
          );
        }
        continue;
      }

      const decision = buildSleepDecision({
        tab,
        state,
        settings,
        now: Date.now(),
        runtimeBaseUrl: RUNTIME_BASE_URL,
      });

      if (decision.sleep) {
        await sleepTab(tab, decision.reason, { settings });
      }
    } catch {
      // A closed or restricted tab must not abort the rest of the scan.
    }
  }
}

function runTabScan() {
  if (scanInFlight) {
    return scanInFlight;
  }

  scanInFlight = performTabScan().catch(() => null).finally(() => {
    scanInFlight = null;
  });
  return scanInFlight;
}

async function sleepCurrentTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    return { ok: false, reason: 'missing-active-tab' };
  }

  return sleepTab(tab, 'manual-current-tab', { manual: true });
}

async function sleepInactiveYouTubeTabs() {
  const tabs = await api.tabs.query({});
  const { settings } = await readRuntimeSettings();
  const results = [];

  for (const tab of tabs) {
    if (tab.active || !isPressureDomain(tab.url, settings)) {
      continue;
    }

    const reason = isYouTubeUrl(tab.url) ? 'manual-youtube-cleanup' : 'memory-pressure';
    results.push(await sleepTab(tab, reason, { manual: true, settings }));
  }

  return {
    ok: true,
    sleptCount: results.filter((result) => result.ok).length,
    skippedCount: results.filter((result) => !result.ok).length,
  };
}

async function sleepAllExceptCurrent() {
  const [currentTab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!currentTab?.id) {
    return { ok: false, reason: 'missing-active-tab' };
  }

  const tabs = await api.tabs.query({});
  const { settings } = await readRuntimeSettings();
  const results = [];

  for (const tab of tabs) {
    if (!tab.id || tab.id === currentTab.id) {
      continue;
    }

    results.push(await sleepTab(tab, 'manual-all-except-current', { manual: true, settings }));
  }

  return {
    ok: true,
    sleptCount: results.filter((result) => result.ok).length,
    skippedCount: results.filter((result) => !result.ok).length,
  };
}

async function freeMemoryNow() {
  const { settings } = await readRuntimeSettings();
  const tabs = await api.tabs.query({});
  const sleepingTabs = await readCurrentSleepingTabs(settings);
  const results = [];

  for (const tab of tabs) {
    if (!tab?.id || tab.active || !isPressureDomain(tab.url, settings)) {
      continue;
    }

    results.push(await sleepTab(tab, 'manual-memory-cleanup', { manual: true, settings }));
  }

  return {
    ok: true,
    sleptCount: results.filter((result) => result.ok).length,
    skippedCount: results.filter((result) => !result.ok).length,
    prunedSleepEntries: Object.keys(sleepingTabs).length,
  };
}

function sleepingTabsListFromStore(sleepingTabs) {
  return Object.values(sleepingTabs)
    .filter((entry) => entry?.url && entry?.token)
    .map((entry) => ({
      ...entry,
      reasonLabel: formatReason(entry.reason),
      hostname: hostnameFromUrl(entry.url),
    }))
    .sort((left, right) => Number(right.sleptAt || 0) - Number(left.sleptAt || 0));
}

async function readCurrentSleepingTabs(settings = null) {
  const resolvedSettings = settings ?? await readSettings();
  const openTabs = await api.tabs.query({});
  return mutateObject(STORAGE_KEYS.sleepingTabs, (sleepingTabs) => {
    const currentSleepingTabs = reconcileSleepingTabsWithOpenTabs(
      sleepingTabs,
      openTabs,
      resolvedSettings,
      RUNTIME_BASE_URL,
    );
    for (const token of Object.keys(sleepingTabs)) {
      delete sleepingTabs[token];
    }
    Object.assign(sleepingTabs, currentSleepingTabs);
    return currentSleepingTabs;
  });
}

async function restoreAllSleepingTabs() {
  const sleepingTabs = await readCurrentSleepingTabs();
  let restoredCount = 0;
  let skippedCount = 0;

  for (const [token, entry] of Object.entries(sleepingTabs)) {
    const restorableUrl = normalizeRestorableUrl(entry?.url);
    if (!entry?.tabId || !restorableUrl) {
      skippedCount += 1;
      continue;
    }

    try {
      await api.tabs.update(entry.tabId, { url: restorableUrl });
      await patchTabState(entry.tabId, {
        lastActiveAt: Date.now(),
        sleepToken: null,
        restoredAt: Date.now(),
      });
      await mutateObject(STORAGE_KEYS.sleepingTabs, (currentSleepingTabs) => {
        delete currentSleepingTabs[token];
      });
      restoredCount += 1;
    } catch {
      skippedCount += 1;
    }
  }

  return { ok: true, restoredCount, skippedCount };
}

async function toggleCurrentDomainInAllowlist() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  const host = hostnameFromUrl(tab?.url);
  if (!host) {
    return { ok: false, reason: 'missing-domain' };
  }

  const settings = await readSettings();
  const result = toggleAllowlistForHost(settings.allowlist ?? [], host);

  await writeSettings({ ...settings, allowlist: result.allowlist });
  return {
    ok: true,
    enabled: result.enabled,
    domain: host,
    settings: await readSettings(),
  };
}

async function setProfile(profile) {
  const profileSettings = applyProfile(profile);
  const settings = await readSettings();
  await writeSettings({
    ...settings,
    ...profileSettings,
  });
  return { ok: true, settings: await readSettings() };
}

async function getPopupState() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  const { settings, powerStatus } = await readRuntimeSettings();
  const state = tab?.id ? await getTabState(tab.id) : {};
  const sleepingTabs = await readCurrentSleepingTabs(settings);
  const token = tab?.url ? extractKnownSleepToken(tab.url, settings) : null;
  const sleepEntry = token ? sleepingTabs[token] : null;
  const effectiveUrl = sleepEntry?.url || tab?.url;

  return {
    tab,
    settings,
    powerStatus,
    state,
    isSleeping: Boolean(token),
    sleepEntry,
    reasonLabel: sleepEntry ? formatReason(sleepEntry.reason) : '',
    currentHost: hostnameFromUrl(effectiveUrl),
    sleepingTabs: sleepingTabsListFromStore(sleepingTabs),
  };
}

async function getSleepEntry(token) {
  const sleepingTabs = await readObject(STORAGE_KEYS.sleepingTabs);
  if (sleepingTabs[token]) {
    return sleepingTabs[token];
  }

  return readArchivedSleepEntry(await readSettings(), token);
}

async function cleanupRemovedTab(tabId) {
  const state = await mutateObject(STORAGE_KEYS.tabStates, (states) => {
    const removedState = states[String(tabId)];
    delete states[String(tabId)];
    return removedState;
  });

  if (state?.sleepToken) {
    await mutateObject(STORAGE_KEYS.sleepingTabs, (sleepingTabs) => {
      delete sleepingTabs[state.sleepToken];
    });
  }
}

async function resetYouTubeCounter(tabId) {
  const state = await getTabState(tabId);
  await patchTabState(tabId, {
    youtubeVideoCount: 0,
    youtubeLastVideoUrl: state.youtubeLastVideoUrl || '',
  });
  try {
    await api.tabs.sendMessage(tabId, { type: 'tab-sleeper:reset-youtube-counter' });
  } catch {
    // The content script may be unavailable on a restricted page.
  }
}

api.runtime.onInstalled.addListener(async () => {
  const result = await api.storage.local.get(STORAGE_KEYS.settings);
  if (!result[STORAGE_KEYS.settings]) {
    await writeSettings(DEFAULT_SETTINGS);
  }
  api.alarms.create(SCAN_ALARM, { periodInMinutes: 1 });
});

api.runtime.onStartup?.addListener(() => {
  api.alarms.create(SCAN_ALARM, { periodInMinutes: 1 });
});

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SCAN_ALARM) {
    void runTabScan();
  }
});

api.tabs.onActivated.addListener(({ tabId }) => {
  void markTabActive(tabId);
});

api.windows.onFocusChanged?.addListener(async (windowId) => {
  if (windowId === api.windows.WINDOW_ID_NONE) {
    return;
  }

  const [tab] = await api.tabs.query({ active: true, windowId });
  if (tab?.id) {
    await markTabActive(tab.id);
  }
});

api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.title || changeInfo.status === 'complete') {
    void patchTabState(tabId, {
      title: tab.title,
      url: tab.url,
      favIconUrl: tab.favIconUrl,
      lastActiveAt: tab.active ? Date.now() : undefined,
    });
  }
});

api.tabs.onRemoved.addListener((tabId) => {
  void cleanupRemovedTab(tabId);
});

async function handleRuntimeMessage(message, sender) {
  const tabId = sender?.tab?.id;

  if (message?.type === 'tab-sleeper:page-state' && tabId) {
    const existingState = sender.tab ? await ensureTabState(sender.tab) : await getTabState(tabId);
    const youtubeState = mergeYouTubePageState(existingState, message);
    await patchTabState(tabId, {
      dirty: Boolean(message.dirty),
      ...youtubeState,
    });
    return { ok: true };
  }

  if (message?.type === 'tab-sleeper:get-popup-state') {
    return getPopupState();
  }

  if (message?.type === 'tab-sleeper:sleep-current') {
    return sleepCurrentTab();
  }

  if (message?.type === 'tab-sleeper:sleep-inactive-youtube') {
    return sleepInactiveYouTubeTabs();
  }

  if (message?.type === 'tab-sleeper:sleep-all-except-current') {
    return sleepAllExceptCurrent();
  }

  if (message?.type === 'tab-sleeper:restore' && message.token) {
    return restoreSleepingTab(message.tabId, message.token);
  }

  if (message?.type === 'tab-sleeper:restore-all') {
    return restoreAllSleepingTabs();
  }

  if (message?.type === 'tab-sleeper:free-memory-now') {
    return freeMemoryNow();
  }

  if (message?.type === 'tab-sleeper:get-sleep-entry' && message.token) {
    return getSleepEntry(message.token);
  }

  if (message?.type === 'tab-sleeper:get-sleeping-tabs') {
    const sleepingTabs = await readCurrentSleepingTabs();
    return { ok: true, sleepingTabs: sleepingTabsListFromStore(sleepingTabs) };
  }

  if (message?.type === 'tab-sleeper:get-settings') {
    return readSettings();
  }

  if (message?.type === 'tab-sleeper:save-settings') {
    await writeSettings(message.settings);
    return { ok: true };
  }

  if (message?.type === 'tab-sleeper:set-profile') {
    return setProfile(message.profile);
  }

  if (message?.type === 'tab-sleeper:toggle-allowlist-current') {
    return toggleCurrentDomainInAllowlist();
  }

  if (message?.type === 'tab-sleeper:reset-youtube-counter' && tabId) {
    await resetYouTubeCounter(tabId);
    return { ok: true };
  }

  return { ok: false, reason: 'unknown-message' };
}

api.runtime.onMessage.addListener(makeRuntimeMessageListener(handleRuntimeMessage));

api.alarms.create(SCAN_ALARM, { periodInMinutes: 1 });
void runTabScan();
