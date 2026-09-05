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
  isAllowlisted,
  isKnownSleepPageUrl,
  isPressureDomain,
  isYouTubeUrl,
  makeSleepToken,
  makeRuntimeMessageListener,
  mergeYouTubePageState,
  mergeSettings,
  normalizeAllowlist,
  normalizeRestorableUrl,
  reconcileSleepingTabsWithOpenTabs,
  shouldHealStuckSleepTab,
  shouldTreatYouTubeAsHighRisk,
  setAllowlistForHost,
  toggleAllowlistForHost,
} from './core.js';
import { companionMutationHeaders } from '../shared/companion-auth.js';

const api = globalThis.browser ?? globalThis.chrome;
const RUNTIME_BASE_URL = api.runtime.getURL('/');
const SCAN_ALARM = 'tab-sleeper-scan';
const SETTINGS_SCHEMA_VERSION = 2;
const STORAGE_KEYS = {
  settings: 'settings',
  settingsSchemaVersion: 'settingsSchemaVersion',
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
let settingsInitialization = null;
let companionSettingsSyncQueue = Promise.resolve();
let lastCompanionSettings = '';
let lastCompanionSyncAt = 0;
const activeTabsByWindow = new Map();
const pendingTabRestores = new Map();
let lastActiveTabId = null;
let lastActiveWindowId = null;
let activeTabDebug = { source: 'not-queried' };

async function boundedPageRequest(request, timeoutMs = 2000) {
  let timer;
  try {
    return await Promise.race([request, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('page-state-timeout')), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function domainKeyFromUrl(url) {
  const host = hostnameFromUrl(url);
  if (!host) {
    return '';
  }
  return isYouTubeUrl(url) ? 'youtube.com' : host.replace(/^www\./, '');
}

function countTabsByDomain(tabs) {
  const counts = new Map();
  for (const tab of tabs) {
    const key = domainKeyFromUrl(tab?.url);
    if (key && !tab.discarded && !isKnownSleepPageUrl(tab.url, DEFAULT_SETTINGS, RUNTIME_BASE_URL)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

async function countSameDomainTabs(tab) {
  const key = domainKeyFromUrl(tab?.url);
  if (!key) {
    return 1;
  }
  const counts = countTabsByDomain(await api.tabs.query({}));
  return Math.max(1, counts.get(key) ?? 1);
}

function rememberActiveTab(tabId, windowId = null) {
  if (tabId == null) {
    return;
  }
  lastActiveTabId = tabId;
  if (windowId != null) {
    lastActiveWindowId = windowId;
    activeTabsByWindow.set(windowId, tabId);
  }
}

function debugActiveTab(source, tab, hint = {}) {
  activeTabDebug = {
    source,
    hintTabId: hint.currentTabId ?? null,
    rememberedTabId: lastActiveTabId,
    tabId: tab?.id ?? null,
    tabUrl: tab?.url || '',
    tabTitle: tab?.title || '',
    windowId: tab?.windowId ?? null,
  };
  return tab;
}

async function readSettings() {
  await (storageMutationQueues.get(STORAGE_KEYS.settings) ?? Promise.resolve());
  const result = await api.storage.local.get([
    STORAGE_KEYS.settings,
    STORAGE_KEYS.settingsSchemaVersion,
  ]);
  if (
    result[STORAGE_KEYS.settings]
    && Number(result[STORAGE_KEYS.settingsSchemaVersion]) >= SETTINGS_SCHEMA_VERSION
  ) {
    const storedSettings = mergeSettings(result[STORAGE_KEYS.settings]);
    void syncCompanionSettings(storedSettings);
    return storedSettings;
  }

  if (!settingsInitialization) {
    settingsInitialization = initializeSettingsFromCompanion(result[STORAGE_KEYS.settings]).finally(() => {
      settingsInitialization = null;
    });
  }
  return settingsInitialization;
}

async function initializeSettingsFromCompanion(storedSettings = null) {
  const baseline = mergeSettings(storedSettings ?? DEFAULT_SETTINGS);
  const companion = await readLocalJson(baseline, '/settings');
  const restoredAllowlist = companion?.ready && Array.isArray(companion.allowlist)
    ? normalizeAllowlist([...(baseline.allowlist ?? []), ...companion.allowlist])
    : baseline.allowlist;
  const settings = mergeSettings({ ...baseline, allowlist: restoredAllowlist });
  await api.storage.local.set({
    [STORAGE_KEYS.settings]: settings,
    [STORAGE_KEYS.settingsSchemaVersion]: SETTINGS_SCHEMA_VERSION,
  });
  await syncCompanionSettings(settings);
  return settings;
}

async function writeSettings(update) {
  await readSettings();
  const mergedSettings = await mutateObject(STORAGE_KEYS.settings, (stored) => {
    const next = mergeSettings(typeof update === 'function' ? update(mergeSettings(stored)) : update);
    Object.assign(stored, next);
    return next;
  });
  void syncCompanionSettings(mergedSettings);
  return mergedSettings;
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
    if (tab.active !== state.wasActive) patch.wasActive = tab.active;
    if (tab.windowId !== state.windowId) patch.windowId = tab.windowId;
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
      mediaPlaying: false,
      wasActive: tab.active,
      windowId: tab.windowId,
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
  let response = null;
  try {
    response = await boundedPageRequest(api.tabs.sendMessage(tab.id, { type: 'tab-sleeper:can-sleep' }, { frameId: 0 }));
  } catch {
    // Older Safari tabs may have no content-script receiver yet.
  }

  if (api.scripting?.executeScript) {
    try {
      const results = await boundedPageRequest(api.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => {
          if (typeof globalThis.__tabSleeperReadState === 'function') {
            return globalThis.__tabSleeperReadState();
          }
          const fields = document.querySelectorAll('input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]), textarea, select, [contenteditable="true"]');
          const dirty = Array.from(fields).some((field) => {
            if (field instanceof HTMLInputElement && (field.type === 'checkbox' || field.type === 'radio')) {
              return field.checked !== field.defaultChecked;
            }
            if (field instanceof HTMLSelectElement) {
              const options = Array.from(field.options);
              let expectedIndex = -1;
              if (!field.multiple) {
                for (let index = 0; index < options.length; index++) if (options[index].defaultSelected) expectedIndex = index;
                if (expectedIndex < 0) expectedIndex = options.findIndex((option) => !option.disabled);
              }
              return options.some((option, index) => option.selected !== (field.multiple ? option.defaultSelected : index === expectedIndex));
            }
            if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
              return field.value !== field.defaultValue;
            }
            return Boolean(field.textContent?.trim());
          });
          const mediaPlaying = Array.from(document.querySelectorAll('audio, video'))
            .some((media) => !media.paused && !media.ended && media.readyState > 0);
          return { canSleep: !dirty, dirty, mediaPlaying, pageUrl: location.href, pageTitle: document.title };
        },
      }));
      const topFrame = results?.find((frame) => frame.frameId === 0)?.result;
      const frames = results?.map((frame) => frame.result).filter((frame) => typeof frame?.dirty === 'boolean') ?? [];
      if (typeof topFrame?.dirty === 'boolean' && frames.length === results.length) {
        response = {
          ...topFrame,
          dirty: frames.some((frame) => frame.dirty),
          mediaPlaying: frames.some((frame) => frame.mediaPlaying),
        };
      } else {
        response = null;
      }
    } catch {
      // A top-frame response cannot prove that embedded forms and media are safe.
      response = null;
    }
  }

  if (typeof response?.dirty === 'boolean' && typeof response?.mediaPlaying === 'boolean') {
    await patchTabState(tab.id, {
      dirty: response.dirty,
      mediaPlaying: response.mediaPlaying,
      pageUrl: response.pageUrl,
      pageTitle: response.pageTitle,
      ...mergeYouTubePageState(state, response),
    });
    return { ...response, canSleep: !settings.protectDirtyForms || !response.dirty };
  }

  return { canSleep: false, reason: 'dirty-state-unavailable', mediaPlaying: Boolean(tab.audible), missingContentScript: true };
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
      headers: companionMutationHeaders(),
      ...options.fetchOptions,
    });
    if (!response.ok) {
      return null;
    }
    return await response.json();
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

function resolveActiveTab(tab, state = {}, hint = {}) {
  if (!tab) {
    return null;
  }

  if (tab.url && (isKnownSleepPageUrl(tab.url, DEFAULT_SETTINGS, RUNTIME_BASE_URL) || !normalizeRestorableUrl(tab.url))) return tab;
  const knownUrl = normalizeRestorableUrl(tab.url)
    || normalizeRestorableUrl(hint.currentUrl)
    || normalizeRestorableUrl(state.pageUrl)
    || normalizeRestorableUrl(state.url);
  if (!knownUrl) {
    return tab;
  }

  return {
    ...tab,
    url: knownUrl,
    title: tab.title || hint.currentTitle || state.pageTitle || state.title || knownUrl,
  };
}

function tabMatchesHintUrl(tab, hintedUrl) {
  if (!hintedUrl) {
    return true;
  }
  return normalizeRestorableUrl(tab?.url) === hintedUrl;
}

async function queryActiveTab(hint = {}) {
  const hintedUrl = normalizeRestorableUrl(hint.currentUrl);
  const hintedTabId = Number(hint.currentTabId);
  if (hint.currentTabId != null && Number.isInteger(hintedTabId) && hintedTabId >= 0) {
    try {
      const hintedTab = await api.tabs.get(hintedTabId);
      if (hintedTab && tabMatchesHintUrl(hintedTab, hintedUrl)) {
        return debugActiveTab('hinted-tab', hintedTab, hint);
      }
      return debugActiveTab('stale-tab-hint', null, hint);
    } catch {
      return debugActiveTab('missing-hinted-tab', null, hint);
    }
  }

  if (lastActiveTabId != null) {
    try {
      const rememberedTab = await api.tabs.get(lastActiveTabId);
      if (rememberedTab?.active && tabMatchesHintUrl(rememberedTab, hintedUrl)) {
        return debugActiveTab('remembered-tab', rememberedTab, hint);
      }
    } catch {
      lastActiveTabId = null;
    }
  }

  try {
    const window = await api.windows.getLastFocused({ populate: true });
    const tab = window?.tabs?.find((candidate) => candidate.active);
    if (tab && tabMatchesHintUrl(tab, hintedUrl)) {
      return debugActiveTab('last-focused-window', tab, hint);
    }
  } catch {
    // Safari popovers are not always associated with currentWindow.
  }

  if (api.tabs.getSelected) {
    try {
      const tab = await api.tabs.getSelected(lastActiveWindowId ?? undefined);
      if (tab && tabMatchesHintUrl(tab, hintedUrl)) {
        return debugActiveTab('get-selected', tab, hint);
      }
    } catch {
      // Safari keeps this legacy Chromium API on some releases only.
    }
  }

  for (const query of [
    { active: true, lastFocusedWindow: true },
    { active: true, currentWindow: true },
    { active: true },
  ]) {
    try {
      const [tab] = await api.tabs.query(query);
      if (tab && tabMatchesHintUrl(tab, hintedUrl)) {
        return debugActiveTab(`tabs-query:${Object.keys(query).join(',')}`, tab, hint);
      }
    } catch {
      // Older Safari versions may not support every Chromium query flag.
    }
  }

  if (hintedUrl) {
    try {
      const tabs = await api.tabs.query({});
      const matchingTabs = tabs.filter((candidate) => tabMatchesHintUrl(candidate, hintedUrl));
      const matchingTab = matchingTabs.find((candidate) => candidate.active && candidate.windowId === lastActiveWindowId)
        || (matchingTabs.length === 1 ? matchingTabs[0] : null);
      if (matchingTab) {
        return debugActiveTab('hinted-url-unique-match', matchingTab, hint);
      }
    } catch {
      // The UI will report that Safari did not expose a stable tab ID.
    }
  }

  debugActiveTab('not-found', null, hint);
  return null;
}

async function readLivePageHint(tabId) {
  if (tabId == null) {
    return null;
  }

  try {
    const response = await api.tabs.sendMessage(tabId, { type: 'tab-sleeper:get-page-info' });
    if (normalizeRestorableUrl(response?.pageUrl)) {
      return response;
    }
  } catch {
    // Pages opened before the extension was enabled do not have the content script yet.
  }

  if (!api.scripting?.executeScript) {
    return null;
  }

  try {
    const results = await api.scripting.executeScript({
      target: { tabId },
      func: () => ({
        pageUrl: location.href,
        pageTitle: document.title,
      }),
    });
    const result = results?.[0]?.result;
    return normalizeRestorableUrl(result?.pageUrl) ? result : null;
  } catch {
    return null;
  }
}

async function resolveCurrentTab(hint = {}) {
  const rawTab = await queryActiveTab(hint);
  if (rawTab?.id == null) {
    return { tab: rawTab, state: {} };
  }

  let state = await getTabState(rawTab.id);
  let tab = resolveActiveTab(rawTab, state, hint);
  if (tab?.url) {
    return { tab, state };
  }

  const pageHint = await readLivePageHint(rawTab.id);
  if (!pageHint) {
    return { tab, state };
  }

  state = await patchTabState(rawTab.id, {
    pageUrl: pageHint.pageUrl,
    pageTitle: pageHint.pageTitle,
    url: pageHint.pageUrl,
    title: pageHint.pageTitle,
  });
  tab = resolveActiveTab(rawTab, state, {
    ...hint,
    currentUrl: pageHint.pageUrl,
    currentTitle: pageHint.pageTitle,
  });
  return { tab, state };
}

async function readRuntimeSettings() {
  const baseSettings = await readSettings();
  void syncExtensionHeartbeat(baseSettings);
  const powerStatus = await readPowerStatus(baseSettings);
  return {
    baseSettings,
    settings: applyPowerMode(baseSettings, powerStatus),
    powerStatus,
  };
}

async function archiveSleepEntry(settings, entry) {
  const tabs = await api.tabs.query({});
  return readLocalJson(settings, '/archive-entry', {
    timeoutMs: 900,
    fetchOptions: {
      method: 'POST',
      headers: companionMutationHeaders(),
      body: JSON.stringify({ entry, activeTokens: [...new Set([
        ...tabs.map((tab) => extractKnownSleepToken(tab.url, settings)).filter(Boolean),
        entry.token,
      ])] }),
    },
  });
}

function syncCompanionSettings(settings) {
  const snapshot = mergeSettings(settings);
  const body = JSON.stringify({ allowlist: snapshot.allowlist, pressureDomains: snapshot.pressureDomains });
  const operation = companionSettingsSyncQueue.then(async () => {
    if (body === lastCompanionSettings && Date.now() - lastCompanionSyncAt < 60_000) return null;
    const result = await readLocalJson(snapshot, '/settings', {
      timeoutMs: 1500,
      fetchOptions: {
        method: 'POST',
        headers: companionMutationHeaders(),
        body,
      },
    });
    if (result?.ok) {
      lastCompanionSettings = body;
      lastCompanionSyncAt = Date.now();
    }
    return result;
  });
  companionSettingsSyncQueue = operation.catch(() => null);
  return operation;
}

function syncExtensionHeartbeat(settings) {
  return readLocalJson(settings, '/heartbeat', {
    timeoutMs: 1200,
    fetchOptions: {
      method: 'POST',
      headers: companionMutationHeaders(),
      body: JSON.stringify({ version: api.runtime.getManifest?.().version || '' }),
    },
  });
}

async function consumeMemoryCleanupRequest(settings = null) {
  const resolvedSettings = settings ?? await readSettings();
  const request = await readLocalJson(resolvedSettings, '/cleanup-request', { timeoutMs: 700 });
  if (!request?.pending || !request.requestId) {
    return null;
  }

  const result = await freeMemoryNow({
    settings: resolvedSettings,
    automatic: true,
    reason: 'memory-pressure',
  });
  await readLocalJson(resolvedSettings, '/cleanup-request', {
    timeoutMs: 700,
    fetchOptions: {
      method: 'POST',
      headers: companionMutationHeaders(),
      body: JSON.stringify({ action: 'ack', requestId: request.requestId, result }),
    },
  });
  return result;
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
    return buildLocalSleepPageUrl(settings.sleepServerUrl || DEFAULT_SETTINGS.sleepServerUrl, token);
  }

  if (settings.requireLocalSleepServer) {
    return null;
  }

  return buildSleepPageUrl(RUNTIME_BASE_URL, token);
}

function extractKnownSleepToken(tabUrl, settings) {
  const extensionToken = extractSleepToken(tabUrl, RUNTIME_BASE_URL);
  if (extensionToken) {
    return extensionToken;
  }

  return extractLocalSleepToken(tabUrl, settings.sleepServerUrl || DEFAULT_SETTINGS.sleepServerUrl);
}

function sleepTab(tab, reason, options = {}) {
  if (tab?.id == null) {
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
  const settings = applyPowerMode(await readSettings(), { source: options.settings?.powerMode });
  if (isKnownSleepPageUrl(tab?.url, settings, RUNTIME_BASE_URL)) {
    return { ok: false, reason: 'already-sleeping' };
  }
  const state = await ensureTabState(tab);
  const guard = await askPageCanSleep(tab, settings, state);

  if (!guard.canSleep && !options.forceDirty) {
    return { ok: false, reason: guard.reason || 'dirty-form' };
  }

  const immediate = Boolean(options.immediate);
  const stateForDecision = {
    ...state,
    dirty: guard.dirty,
    mediaPlaying: guard.mediaPlaying,
  };
  const sameDomainTabCount = options.manual ? 1 : await countSameDomainTabs(tab);
  if (
    !options.manual
    && Boolean(tab.audible || stateForDecision.mediaPlaying)
    && sameDomainTabCount === 1
  ) {
    return { ok: false, reason: 'single-media-tab' };
  }
  const decision = options.manual || immediate
    ? buildManualSleepDecision({ tab, state: stateForDecision, settings, runtimeBaseUrl: RUNTIME_BASE_URL })
    : buildSleepDecision({
      tab,
      state: stateForDecision,
      settings,
      runtimeBaseUrl: RUNTIME_BASE_URL,
      sameDomainTabCount,
    });

  if (options.manual || immediate ? !decision.eligible : !decision.sleep) {
    return { ok: false, reason: decision.reason };
  }

  let currentTab;
  try {
    currentTab = await api.tabs.get(tab.id);
  } catch {
    return { ok: false, reason: 'missing-tab' };
  }
  if (!tabIdentityMatches(tab, currentTab)) {
    return { ok: false, reason: 'tab-changed' };
  }
  tab = currentTab;
  const initialValidation = await validateSleepCommit(tab, stateForDecision, options);
  if (!initialValidation.ok) return initialValidation;

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
    restoreOnFocus: settings.restoreOnFocus,
  };
  const strategy = chooseUnloadStrategy({
    tab,
    capabilities: { tabsDiscard: typeof api.tabs.discard === 'function' },
    manual: Boolean(options.manual) && !immediate,
  });

  if (strategy === 'native-discard') {
    let discardedTab = null;
    try {
      await api.tabs.discard(tab.id);
      discardedTab = await api.tabs.get(tab.id);
    } catch {
      // Unsupported discard falls back to a sleep page after another validation.
    }
    if (discardedTab?.discarded && tabIdentityMatches(tab, discardedTab)) {
      await mutateObject(STORAGE_KEYS.sleepingTabs, (sleepingTabs) => {
        sleepingTabs[token] = sleepEntry;
      });
      await patchTabState(tab.id, {
        sleepToken: token,
        sleptAt,
        dirty: false,
        sleepStrategy: 'native-discard',
      });
      await archiveSleepEntry(settings, sleepEntry);
      return { ok: true, token, reason, strategy };
    }
  }

  const sleepUrl = await buildSleepNavigationUrl(settings, token, sleepEntry);
  if (!sleepUrl) {
    return { ok: false, reason: 'sleep-server-unavailable' };
  }

  // The local page only has a token. Its recovery record must be durable first.
  const archive = await archiveSleepEntry(settings, sleepEntry);
  if (!archive?.ok) {
    return { ok: false, reason: 'archive-unavailable' };
  }
  try {
    await mutateObject(STORAGE_KEYS.sleepingTabs, (sleepingTabs) => {
      sleepingTabs[token] = sleepEntry;
    });
    await patchTabState(tab.id, { sleepToken: token, sleptAt, sleepStrategy: 'sleep-page' });
    const finalGuard = await askPageCanSleep(tab, await readSettings(), await getTabState(tab.id));
    const validation = finalGuard.canSleep
      ? await validateSleepCommit(tab, finalGuard, options)
      : { ok: false, reason: finalGuard.reason || 'dirty-form' };
    if (!validation.ok) {
      await rollbackSleepPreparation(tab.id, token);
      await deleteArchivedSleepEntry(settings, token);
      return validation;
    }
    await api.tabs.update(tab.id, { url: sleepUrl });
  } catch {
    await rollbackSleepPreparation(tab.id, token);
    await deleteArchivedSleepEntry(settings, token);
    return { ok: false, reason: 'sleep-navigation-failed' };
  }
  return { ok: true, token, reason, strategy: 'sleep-page' };
}

async function deleteArchivedSleepEntry(settings, token) {
  return readLocalJson(settings, '/archive-entry', {
    fetchOptions: { method: 'POST', body: JSON.stringify({ action: 'delete', token }) },
  });
}

async function validateSleepCommit(expectedTab, guard, options) {
  const settings = applyPowerMode(await readSettings(), { source: options.settings?.powerMode });
  const state = await getTabState(expectedTab.id);
  const sameDomainTabCount = await countSameDomainTabs(expectedTab);
  let tab;
  try {
    tab = await api.tabs.get(expectedTab.id);
  } catch {
    return { ok: false, reason: 'missing-tab' };
  }
  if (!tabIdentityMatches(expectedTab, tab)) return { ok: false, reason: 'tab-changed' };
  if (options.manual && options.allowActive !== true && tab.active) return { ok: false, reason: 'active-tab' };
  if (!options.manual && tab.active) return { ok: false, reason: 'active-tab' };
  const liveState = { ...state, dirty: state.dirty || guard.dirty, mediaPlaying: guard.mediaPlaying || state.mediaPlaying };
  if (!options.manual && (tab.audible || liveState.mediaPlaying) && sameDomainTabCount === 1) {
    return { ok: false, reason: 'single-media-tab' };
  }
  const decision = options.manual || options.immediate
    ? buildManualSleepDecision({ tab, state: liveState, settings, runtimeBaseUrl: RUNTIME_BASE_URL })
    : buildSleepDecision({ tab, state: liveState, settings, sameDomainTabCount, runtimeBaseUrl: RUNTIME_BASE_URL });
  return { ok: Boolean(decision.eligible ?? decision.sleep), reason: decision.reason };
}

function tabIdentityMatches(expected, current) {
  return expected?.id === current?.id
    && (expected.windowId == null || current.windowId == null || expected.windowId === current.windowId)
    && normalizeRestorableUrl(expected.url) === normalizeRestorableUrl(current.url);
}

async function restoreSleepingTab(tabId, token) {
  if (!Number.isInteger(tabId) || tabId < 0) return { ok: false, reason: 'missing-tab' };
  if (pendingTabRestores.has(tabId)) return pendingTabRestores.get(tabId);
  const operation = performRestoreSleepingTab(tabId, token);
  pendingTabRestores.set(tabId, operation);
  return operation.finally(() => pendingTabRestores.delete(tabId));
}

async function performRestoreSleepingTab(tabId, token) {
  const settings = await readSettings();
  const sleepingTabs = await readObject(STORAGE_KEYS.sleepingTabs);
  const entry = sleepingTabs[token] ?? await readArchivedSleepEntry(settings, token);
  const restorableUrl = normalizeRestorableUrl(entry?.url);
  if (!restorableUrl) {
    return { ok: false, reason: 'missing-sleep-entry' };
  }
  const tab = await api.tabs.get(tabId);
  const matchesSleepPage = extractKnownSleepToken(tab.url, settings) === token;
  const matchesNativeSleep = tab.discarded && entry.tabId === tabId && normalizeRestorableUrl(tab.url) === restorableUrl;
  if (!matchesSleepPage && !matchesNativeSleep) return { ok: false, reason: 'tab-changed' };
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

async function maybeRestoreOnFocus(tab, restoreManual = false) {
  const settings = await readSettings();
  if (!settings.restoreOnFocus || !tab?.url) {
    return;
  }

  const token = extractKnownSleepToken(tab.url, settings);
  if (token) {
    if (!restoreManual && (await getSleepEntry(token))?.autoRestore === false) return;
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
        if ((await getSleepEntry(token))?.autoRestore !== false) {
          await restoreSleepingTab(currentTab.id, token);
        }
      }
    } catch {
      // The tab may have closed before the retry.
    } finally {
      pendingSleepHeals.delete(key);
    }
  }, 1800);
}

async function markTabActive(tabId, restoreManual = false) {
  try {
    const tab = await api.tabs.get(tabId);
    await patchTabState(tabId, {
      lastActiveAt: Date.now(),
      title: tab.title,
      url: tab.url,
      favIconUrl: tab.favIconUrl,
      wasActive: true,
      windowId: tab.windowId,
    });
    await maybeRestoreOnFocus(tab, restoreManual);
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
  const activeTabs = tabs.filter((tab) => tab.active && tab.id != null);
  const domainTabCounts = countTabsByDomain(tabs);
  const openTabIds = new Set(tabs.filter((tab) => tab.id != null).map((tab) => String(tab.id)));
  await mutateObject(STORAGE_KEYS.tabStates, (states) => {
    for (const tabId of Object.keys(states)) {
      if (!openTabIds.has(tabId)) {
        delete states[tabId];
      }
    }
  });
  await readCurrentSleepingTabs(settings, tabs);
  const activeTab = activeTabs.find((tab) => tab.windowId === lastActiveWindowId)
    || (activeTabs.length === 1 ? activeTabs[0] : null);
  if (activeTab) {
    rememberActiveTab(activeTab.id, activeTab.windowId);
  }

  for (const tab of tabs) {
    try {
      if (tab.id == null || !tab.url) {
        continue;
      }

      const state = await ensureTabState(tab, knownStates[String(tab.id)] ?? {});

      if (tab.active) {
        scheduleStuckSleepHeal(tab, settings);
        continue;
      }

      const decision = buildSleepDecision({
        tab,
        // Cached page state can be stale after a pause, reload or form reset.
        state: { ...state, dirty: false, mediaPlaying: false },
        settings,
        now: Date.now(),
        runtimeBaseUrl: RUNTIME_BASE_URL,
        sameDomainTabCount: domainTabCounts.get(domainKeyFromUrl(tab.url)) ?? 1,
      });

      if (decision.sleep) {
        const result = await sleepTab(tab, decision.reason, { settings });
        await patchTabState(tab.id, { lastSleepCheck: { at: Date.now(), reason: result.reason } });
      }
    } catch {
      // A closed or restricted tab must not abort the rest of the scan.
    }
  }
  await reconcileArchive(settings);
}

function reconcileArchive(settings) {
  const operation = sleepQueue.then(async () => {
    const tabs = await api.tabs.query({});
    const activeTokens = tabs.map((tab) => extractKnownSleepToken(tab.url, settings)).filter(Boolean);
    const sleepingTabs = await readObject(STORAGE_KEYS.sleepingTabs);
    const entries = Object.values(sleepingTabs).filter((entry) => activeTokens.includes(entry.token));
    return readLocalJson(settings, '/archive-entry', {
      timeoutMs: 1500,
      fetchOptions: { method: 'POST', body: JSON.stringify({ action: 'reconcile', activeTokens, entries }) },
    });
  });
  sleepQueue = operation.catch(() => null);
  return operation;
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

async function sleepCurrentTab(hint = {}) {
  const baseSettings = await readSettings();
  const { tab } = await resolveCurrentTab(hint);
  if (tab?.id != null) {
    return sleepTab(tab, 'manual-current-tab', { manual: true, allowActive: true, settings: baseSettings });
  }

  return { ok: false, reason: 'missing-active-tab' };
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
  const tabs = await api.tabs.query({});
  const { settings } = await readRuntimeSettings();
  const results = [];

  for (const tab of tabs) {
    if (tab.id == null || tab.active) {
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

async function freeMemoryNow(options = {}) {
  const settings = options.settings ?? (await readRuntimeSettings()).settings;
  const tabs = await api.tabs.query({});
  const sleepingTabs = await readCurrentSleepingTabs(settings);
  const results = [];

  for (const tab of tabs) {
    if (tab?.id == null || tab.active || !isPressureDomain(tab.url, settings)) {
      continue;
    }

    results.push(await sleepTab(tab, options.reason || 'manual-memory-cleanup', {
      manual: !options.automatic,
      immediate: Boolean(options.automatic),
      settings,
    }));
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

async function readCurrentSleepingTabs(settings = null, knownOpenTabs = null) {
  const resolvedSettings = settings ?? await readSettings();
  const openTabs = knownOpenTabs ?? await api.tabs.query({});
  return mutateObject(STORAGE_KEYS.sleepingTabs, (sleepingTabs) => {
    const currentSleepingTabs = reconcileSleepingTabsWithOpenTabs(
      sleepingTabs,
      openTabs,
      resolvedSettings,
      RUNTIME_BASE_URL,
    );
    for (const [token, entry] of Object.entries(sleepingTabs)) {
      if (pendingTabSleeps.has(entry.tabId)) currentSleepingTabs[token] = entry;
    }
    for (const token of Object.keys(sleepingTabs)) {
      delete sleepingTabs[token];
    }
    Object.assign(sleepingTabs, currentSleepingTabs);
    return currentSleepingTabs;
  });
}

async function restoreAllSleepingTabs() {
  const settings = await readSettings();
  const tabs = await api.tabs.query({});
  const sleepingTabs = await readCurrentSleepingTabs(settings, tabs);
  const targets = new Map(tabs.map((tab) => [tab.id, extractKnownSleepToken(tab.url, settings)]));
  for (const entry of Object.values(sleepingTabs)) {
    if (!targets.get(entry.tabId)) targets.set(entry.tabId, entry.token);
  }
  let restoredCount = 0;
  let skippedCount = 0;

  for (const [tabId, token] of targets) {
    if (!token) continue;
    try {
      const result = await restoreSleepingTab(tabId, token);
      if (result.ok) restoredCount += 1;
      else skippedCount += 1;
    } catch {
      skippedCount += 1;
    }
  }

  return { ok: true, restoredCount, skippedCount };
}

async function toggleCurrentDomainInAllowlist(hint = {}) {
  const { tab } = await resolveCurrentTab(hint);
  const host = hostnameFromUrl(tab?.url);
  if (!host) {
    return { ok: false, reason: 'missing-domain' };
  }

  let result;
  await writeSettings((settings) => {
    result = toggleAllowlistForHost(settings.allowlist ?? [], host);
    return { ...settings, allowlist: result.allowlist };
  });
  return {
    ok: true,
    enabled: result.enabled,
    domain: host,
    settings: await readSettings(),
  };
}

async function setCurrentDomainAllowlisted(hint = {}, enabled = true) {
  const { tab } = await resolveCurrentTab(hint);
  const host = hostnameFromUrl(tab?.url);
  if (!host) {
    return { ok: false, reason: 'missing-domain' };
  }

  let result;
  await writeSettings((settings) => {
    result = setAllowlistForHost(settings.allowlist ?? [], host, enabled);
    return { ...settings, allowlist: result.allowlist };
  });
  if (result.blockedByPattern) {
    return { ok: false, reason: 'covered-by-allowlist-pattern', enabled: true, domain: host };
  }
  return {
    ok: true,
    enabled: result.enabled,
    domain: host,
    settings: await readSettings(),
  };
}

async function setProfile(profile) {
  const profileSettings = applyProfile(profile);
  await writeSettings((settings) => ({
    ...settings,
    ...profileSettings,
  }));
  return { ok: true, settings: await readSettings() };
}

async function getPopupState(hint = {}) {
  const { settings, powerStatus } = await readRuntimeSettings();
  const { tab, state } = await resolveCurrentTab(hint);
  const sleepingTabs = await readCurrentSleepingTabs(settings);
  const token = tab?.url ? extractKnownSleepToken(tab.url, settings) : null;
  const sleepEntry = token ? (sleepingTabs[token] ?? await readArchivedSleepEntry(settings, token)) : null;
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
    hasSleepingTabs: (await api.tabs.query({})).some((candidate) => candidate.discarded || extractKnownSleepToken(candidate.url, settings)),
    activeTabDebug: {
      ...activeTabDebug,
      resolvedTabId: tab?.id ?? null,
      resolvedUrl: tab?.url || '',
      statePageUrl: state.pageUrl || '',
      stateUrl: state.url || '',
    },
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
  const settings = await readSettings();
  await syncExtensionHeartbeat(settings);
  api.alarms.create(SCAN_ALARM, { periodInMinutes: 1 });
});

api.runtime.onStartup?.addListener(() => {
  void readSettings().then(syncExtensionHeartbeat);
  api.alarms.create(SCAN_ALARM, { periodInMinutes: 1 });
});

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SCAN_ALARM) {
    void consumeMemoryCleanupRequest().finally(runTabScan);
  }
});

api.tabs.onActivated.addListener(({ tabId, windowId }) => {
  const previousTabId = activeTabsByWindow.get(windowId);
  const deactivatedAt = Date.now();
  rememberActiveTab(tabId, windowId);
  void mutateObject(STORAGE_KEYS.tabStates, (states) => {
    for (const [id, state] of Object.entries(states)) {
      if (Number(id) !== tabId && (Number(id) === previousTabId || (state.windowId === windowId && state.wasActive))) {
        state.lastActiveAt = deactivatedAt;
        state.wasActive = false;
      }
    }
  }).then(() => markTabActive(tabId, true));
});

api.windows.onFocusChanged?.addListener(async (windowId) => {
  if (windowId === api.windows.WINDOW_ID_NONE) {
    return;
  }

  const [tab] = await api.tabs.query({ active: true, windowId });
  if (tab?.id != null) {
    rememberActiveTab(tab.id, windowId);
    await markTabActive(tab.id);
  }
});

api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.active) {
    rememberActiveTab(tabId, tab.windowId);
  }
  if (changeInfo.url || changeInfo.title || changeInfo.status === 'complete') {
    void patchTabState(tabId, {
      title: tab.title,
      url: tab.url,
      favIconUrl: tab.favIconUrl,
      mediaPlaying: changeInfo.url ? false : undefined,
      lastActiveAt: tab.active ? Date.now() : undefined,
    });
  }
});

api.tabs.onRemoved.addListener((tabId) => {
  void cleanupRemovedTab(tabId);
});

async function handleRuntimeMessage(message, sender) {
  const tabId = sender?.tab?.id;

  if (message?.type === 'tab-sleeper:page-state' && tabId != null) {
    if (sender.frameId != null && sender.frameId !== 0) return { ok: true };
    if (sender.tab?.active) {
      rememberActiveTab(tabId, sender.tab.windowId);
    }
    const existingState = sender.tab ? await ensureTabState(sender.tab) : await getTabState(tabId);
    const youtubeState = mergeYouTubePageState(existingState, message);
    await patchTabState(tabId, {
      dirty: Boolean(message.dirty),
      mediaPlaying: Boolean(message.mediaPlaying),
      pageUrl: message.pageUrl,
      pageTitle: message.pageTitle,
      ...youtubeState,
    });
    return { ok: true };
  }

  if (message?.type === 'tab-sleeper:get-popup-state') {
    return getPopupState(message);
  }

  if (message?.type === 'tab-sleeper:get-companion-active-tab') {
    const settings = await readSettings();
    return (await readLocalJson(settings, '/active-tab', { timeoutMs: 1200 }))
      ?? { ok: false, reason: 'companion-unavailable' };
  }

  if (message?.type === 'tab-sleeper:get-memory-status') {
    const settings = await readSettings();
    return (await readLocalJson(settings, '/memory', { timeoutMs: 1500 }))
      ?? { ok: false, reason: 'companion-unavailable' };
  }

  if (message?.type === 'tab-sleeper:get-power-status') {
    return readPowerStatus(await readSettings());
  }

  if (message?.type === 'tab-sleeper:sleep-current') {
    return sleepCurrentTab(message);
  }

  if (message?.type === 'tab-sleeper:sleep-inactive-youtube') {
    return sleepInactiveYouTubeTabs();
  }

  if (message?.type === 'tab-sleeper:sleep-all-except-current') {
    return sleepAllExceptCurrent();
  }

  if (message?.type === 'tab-sleeper:restore' && message.token) {
    return restoreSleepingTab(tabId ?? message.tabId, message.token);
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
    return toggleCurrentDomainInAllowlist(message);
  }

  if (message?.type === 'tab-sleeper:set-allowlist-current') {
    return setCurrentDomainAllowlisted(message, message.enabled !== false);
  }

  if (message?.type === 'tab-sleeper:reset-youtube-counter') {
    const targetTabId = tabId ?? Number(message.currentTabId);
    if (!Number.isInteger(targetTabId) || targetTabId < 0) {
      return { ok: false, reason: 'missing-active-tab' };
    }
    await resetYouTubeCounter(targetTabId);
    return { ok: true };
  }

  return { ok: false, reason: 'unknown-message' };
}

api.runtime.onMessage.addListener(makeRuntimeMessageListener(handleRuntimeMessage));

api.alarms.create(SCAN_ALARM, { periodInMinutes: 1 });
void readSettings().then(syncExtensionHeartbeat);
void consumeMemoryCleanupRequest();
void runTabScan();
