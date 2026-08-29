export const DEFAULT_SETTINGS = Object.freeze({
  profile: 'balanced',
  inactivityMinutes: 5,
  youtubeVideoThreshold: 20,
  youtubeHighRiskInactiveSeconds: 60,
  aggressiveInactiveSeconds: 60,
  sleepServerUrl: 'http://127.0.0.1:17654/sleep',
  requireLocalSleepServer: true,
  restoreOnFocus: true,
  powerAware: true,
  skipPinned: true,
  skipAudible: true,
  protectDirtyForms: true,
  allowlist: [],
  aggressiveList: [],
  pressureDomains: [
    'youtube.com',
    '*.youtube.com',
    'youtu.be',
    'twitch.tv',
    '*.twitch.tv',
    'netflix.com',
    '*.netflix.com',
    'meet.google.com',
    'figma.com',
    '*.figma.com',
    'canva.com',
    '*.canva.com',
    'reddit.com',
    '*.reddit.com',
    'x.com',
    '*.x.com',
    'twitter.com',
    '*.twitter.com',
  ],
});

const SETTINGS_LIMITS = Object.freeze({
  inactivityMinutes: Object.freeze({ min: 1, max: 180 }),
  youtubeVideoThreshold: Object.freeze({ min: 2, max: 500 }),
  youtubeHighRiskInactiveSeconds: Object.freeze({ min: 10, max: 1800 }),
  aggressiveInactiveSeconds: Object.freeze({ min: 10, max: 1800 }),
});

const PROFILE_SETTINGS = Object.freeze({
  safe: Object.freeze({
    profile: 'safe',
    inactivityMinutes: 15,
    youtubeHighRiskInactiveSeconds: 180,
    skipAudible: true,
  }),
  balanced: Object.freeze({
    profile: 'balanced',
    inactivityMinutes: 5,
    youtubeHighRiskInactiveSeconds: 60,
    skipAudible: true,
  }),
  aggressive: Object.freeze({
    profile: 'aggressive',
    inactivityMinutes: 1,
    youtubeHighRiskInactiveSeconds: 20,
    skipAudible: false,
  }),
});

const INTERNAL_PROTOCOLS = new Set([
  'about:',
  'blob:',
  'data:',
  'file:',
  'safari-extension:',
  'safari-web-extension:',
  'chrome-extension:',
  'moz-extension:',
  'edge-extension:',
]);
const YOUTUBE_FAMILY_DOMAINS = ['youtube.com', 'youtu.be', 'youtube-nocookie.com'];

export function mergeSettings(settings = {}) {
  const profile = Object.hasOwn(PROFILE_SETTINGS, settings.profile)
    ? settings.profile
    : DEFAULT_SETTINGS.profile;
  const profileDefaults = applyProfile(profile);
  const defaults = { ...DEFAULT_SETTINGS, ...profileDefaults };

  return {
    profile,
    inactivityMinutes: clampSettingNumber(settings.inactivityMinutes, defaults.inactivityMinutes, SETTINGS_LIMITS.inactivityMinutes),
    youtubeVideoThreshold: clampSettingNumber(settings.youtubeVideoThreshold, defaults.youtubeVideoThreshold, SETTINGS_LIMITS.youtubeVideoThreshold),
    youtubeHighRiskInactiveSeconds: clampSettingNumber(
      settings.youtubeHighRiskInactiveSeconds,
      defaults.youtubeHighRiskInactiveSeconds,
      SETTINGS_LIMITS.youtubeHighRiskInactiveSeconds,
    ),
    aggressiveInactiveSeconds: clampSettingNumber(
      settings.aggressiveInactiveSeconds,
      defaults.aggressiveInactiveSeconds,
      SETTINGS_LIMITS.aggressiveInactiveSeconds,
    ),
    sleepServerUrl: normalizeSleepServerUrl(settings.sleepServerUrl, defaults.sleepServerUrl),
    requireLocalSleepServer: settingBoolean(settings.requireLocalSleepServer, defaults.requireLocalSleepServer),
    restoreOnFocus: settingBoolean(settings.restoreOnFocus, defaults.restoreOnFocus),
    powerAware: settingBoolean(settings.powerAware, defaults.powerAware),
    skipPinned: settingBoolean(settings.skipPinned, defaults.skipPinned),
    skipAudible: settingBoolean(settings.skipAudible, defaults.skipAudible),
    protectDirtyForms: settingBoolean(settings.protectDirtyForms, defaults.protectDirtyForms),
    allowlist: normalizeAllowlist(settings.allowlist ?? DEFAULT_SETTINGS.allowlist),
    aggressiveList: normalizeAllowlist(settings.aggressiveList ?? DEFAULT_SETTINGS.aggressiveList),
    pressureDomains: normalizeAllowlist(settings.pressureDomains ?? DEFAULT_SETTINGS.pressureDomains),
  };
}

function clampSettingNumber(value, fallback, limits) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return Math.min(limits.max, Math.max(limits.min, numericValue));
}

function settingBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeSleepServerUrl(value, fallback) {
  try {
    const parsed = new URL(String(value || fallback));
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
    ) {
      parsed.pathname = '/sleep';
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    }
  } catch {
    // Fall through to the known-safe localhost endpoint.
  }
  return fallback;
}

export function applyProfile(profile) {
  return { ...(PROFILE_SETTINGS[profile] ?? PROFILE_SETTINGS.balanced) };
}

export function applyPowerMode(settings = DEFAULT_SETTINGS, powerStatus = {}) {
  const normalizedSettings = mergeSettings(settings);
  if (!normalizedSettings.powerAware) {
    return { ...normalizedSettings, powerMode: 'default' };
  }

  if (powerStatus?.source === 'battery') {
    return {
      ...normalizedSettings,
      powerMode: 'battery',
      inactivityMinutes: Math.min(Number(normalizedSettings.inactivityMinutes), 3),
      youtubeHighRiskInactiveSeconds: Math.min(Number(normalizedSettings.youtubeHighRiskInactiveSeconds), 45),
      aggressiveInactiveSeconds: Math.min(Number(normalizedSettings.aggressiveInactiveSeconds), 45),
    };
  }

  if (powerStatus?.source === 'power') {
    return {
      ...normalizedSettings,
      powerMode: 'power',
      inactivityMinutes: Math.max(Number(normalizedSettings.inactivityMinutes), 10),
      youtubeHighRiskInactiveSeconds: Math.max(Number(normalizedSettings.youtubeHighRiskInactiveSeconds), 120),
      aggressiveInactiveSeconds: Math.max(Number(normalizedSettings.aggressiveInactiveSeconds), 120),
    };
  }

  return { ...normalizedSettings, powerMode: 'default' };
}

export function normalizeAllowlist(value) {
  const lines = Array.isArray(value) ? value : String(value ?? '').split(/\r?\n/);

  return Array.from(new Set(lines
    .map((line) => String(line).trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.replace(/\s+#.*$/, '').trim())
    .map((line) => {
      if (line.startsWith('*.')) {
        return line.toLowerCase();
      }

      try {
        const parsed = line.includes('://') ? new URL(line) : new URL(`https://${line}`);
        return parsed.hostname.toLowerCase();
      } catch {
        return line
          .replace(/^https?:\/\//i, '')
          .replace(/\/.*$/, '')
          .toLowerCase();
      }
    })
    .filter(Boolean)));
}

export function buildSleepPageUrl(runtimeBaseUrl, token, fallbackEntry = null) {
  const url = new URL('sleep/sleep.html', runtimeBaseUrl);
  url.searchParams.set('token', token);

  if (fallbackEntry) {
    url.hash = encodeSleepFallback(fallbackEntry).replace(/^#/, '');
  }

  return url.toString();
}

export function buildLocalSleepPageUrl(serverUrl, fallbackEntry) {
  const url = new URL(serverUrl);
  url.hash = encodeSleepFallback(fallbackEntry).replace(/^#/, '');
  return url.toString();
}

export function isLocalSleepPageUrl(candidateUrl, serverUrl = DEFAULT_SETTINGS.sleepServerUrl) {
  try {
    const sleepUrl = new URL(serverUrl);
    const candidate = new URL(candidateUrl);
    return urlsHaveSameAuthority(candidate, sleepUrl) && candidate.pathname === sleepUrl.pathname;
  } catch {
    return false;
  }
}

export function isSleepPageUrl(candidateUrl, runtimeBaseUrl) {
  try {
    const sleepUrl = new URL('sleep/sleep.html', runtimeBaseUrl);
    const candidate = new URL(candidateUrl);
    return urlsHaveSameAuthority(candidate, sleepUrl) && candidate.pathname === sleepUrl.pathname;
  } catch {
    return false;
  }
}

export function isKnownSleepPageUrl(candidateUrl, settings = DEFAULT_SETTINGS, runtimeBaseUrl = '') {
  const normalizedSettings = mergeSettings(settings);
  return isLocalSleepPageUrl(candidateUrl, normalizedSettings.sleepServerUrl)
    || Boolean(runtimeBaseUrl && isSleepPageUrl(candidateUrl, runtimeBaseUrl));
}

function urlsHaveSameAuthority(left, right) {
  return left.protocol === right.protocol
    && left.hostname === right.hostname
    && left.port === right.port;
}

export function extractSleepToken(candidateUrl, runtimeBaseUrl) {
  if (!isSleepPageUrl(candidateUrl, runtimeBaseUrl)) {
    return null;
  }

  try {
    return new URL(candidateUrl).searchParams.get('token');
  } catch {
    return null;
  }
}

export function extractLocalSleepToken(candidateUrl, serverUrl = DEFAULT_SETTINGS.sleepServerUrl) {
  if (!isLocalSleepPageUrl(candidateUrl, serverUrl)) {
    return null;
  }

  try {
    return decodeSleepFallback(new URL(candidateUrl).hash)?.token ?? null;
  } catch {
    return null;
  }
}

export function reconcileSleepingTabsWithOpenTabs(
  sleepingTabs = {},
  openTabs = [],
  settings = DEFAULT_SETTINGS,
  runtimeBaseUrl = '',
) {
  const normalizedSettings = mergeSettings(settings);
  const tabsById = new Map();
  const sleepPageTabsByToken = new Map();

  for (const tab of openTabs) {
    if (typeof tab?.id !== 'number') {
      continue;
    }

    tabsById.set(tab.id, tab);
    const token = (runtimeBaseUrl ? extractSleepToken(tab.url, runtimeBaseUrl) : null)
      || extractLocalSleepToken(tab.url, normalizedSettings.sleepServerUrl);
    if (token) {
      sleepPageTabsByToken.set(token, tab);
    }
  }

  const nextSleepingTabs = {};
  for (const [storageToken, entry] of Object.entries(sleepingTabs ?? {})) {
    const entryUrl = normalizeRestorableUrl(entry?.url);
    if (!entryUrl) {
      continue;
    }

    const token = String(entry.token || storageToken);
    const sleepPageTab = sleepPageTabsByToken.get(token);
    if (sleepPageTab) {
      nextSleepingTabs[storageToken] = {
        ...entry,
        token,
        tabId: sleepPageTab.id,
        url: entryUrl,
      };
      continue;
    }

    const matchingTab = tabsById.get(Number(entry.tabId));
    const tabUrl = normalizeRestorableUrl(matchingTab?.url);
    if (matchingTab?.discarded === true && tabUrl && tabUrl === entryUrl) {
      nextSleepingTabs[storageToken] = {
        ...entry,
        token,
        tabId: matchingTab.id,
        url: entryUrl,
      };
    }
  }

  return nextSleepingTabs;
}

export function shouldHealStuckSleepTab({ tab, settings = DEFAULT_SETTINGS, runtimeBaseUrl = '' }) {
  if (!tab?.active || !tab.url) {
    return false;
  }

  const normalizedSettings = mergeSettings(settings);
  return Boolean(
    (runtimeBaseUrl && extractSleepToken(tab.url, runtimeBaseUrl))
      || extractLocalSleepToken(tab.url, normalizedSettings.sleepServerUrl),
  );
}

export function makeSleepToken() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function makeRuntimeMessageListener(handleMessage) {
  return (message, sender, sendResponse) => {
    Promise.resolve()
      .then(() => handleMessage(message, sender))
      .then((response) => {
        sendResponse(response);
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          reason: 'runtime-message-error',
          error: String(error?.message ?? error),
        });
      });

    return true;
  };
}

export function encodeSleepFallback(entry) {
  const restorableUrl = normalizeRestorableUrl(entry.url);
  const safeEntry = {
    token: entry.token,
    url: restorableUrl,
    title: entry.title,
    favIconUrl: entry.favIconUrl || '',
    sleptAt: entry.sleptAt,
    reason: entry.reason,
    autoRestore: entry.autoRestore !== false,
  };
  return `#fallback=${base64UrlEncode(JSON.stringify(safeEntry))}`;
}

export function decodeSleepFallback(hashOrValue) {
  try {
    const value = String(hashOrValue ?? '');
    const params = new URLSearchParams(value.startsWith('#') ? value.slice(1) : value);
    const encoded = params.get('fallback') || (value.startsWith('fallback=') ? value.slice('fallback='.length) : value);
    if (!encoded) {
      return null;
    }

    const parsed = JSON.parse(base64UrlDecode(encoded));
    const restorableUrl = normalizeRestorableUrl(parsed?.url);
    if (!parsed || !restorableUrl) {
      return null;
    }

    return {
      token: String(parsed.token || ''),
      url: restorableUrl,
      title: String(parsed.title || restorableUrl),
      ...(parsed.favIconUrl ? { favIconUrl: String(parsed.favIconUrl) } : {}),
      sleptAt: Number(parsed.sleptAt || Date.now()),
      reason: String(parsed.reason || 'manual-current-tab'),
      autoRestore: parsed.autoRestore !== false,
    };
  } catch {
    return null;
  }
}

export function getSleepPageAutoRestoreDelay({ entry, now = Date.now(), minimumSleepMs = 1200 }) {
  if (!entry?.url || entry.autoRestore === false) {
    return null;
  }

  if (entry.reason === 'manual-current-tab') {
    return null;
  }

  const sleptAt = Number(entry.sleptAt || 0);
  if (!sleptAt) {
    return 0;
  }

  return Math.max(0, minimumSleepMs - Math.max(0, now - sleptAt));
}

export function shouldAutoRestoreSleepPage({ entry, now = Date.now(), minimumSleepMs = 1200 }) {
  return getSleepPageAutoRestoreDelay({ entry, now, minimumSleepMs }) === 0;
}

export function getSleepingTabIconUrl({ pageUrl, favIconUrl = '' }) {
  const explicitIcon = String(favIconUrl || '').trim();
  if (isHttpUrl(explicitIcon)) {
    return explicitIcon;
  }

  try {
    const parsed = new URL(normalizeRestorableUrl(pageUrl) || pageUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }

    return `${parsed.origin}/favicon.ico`;
  } catch {
    return '';
  }
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function decodeURIComponentSafely(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseHttpUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch {
    return '';
  }
  return '';
}

export function normalizeRestorableUrl(value) {
  const unwrappedValue = unwrapNestedSleepUrl(value);
  const directUrl = parseHttpUrl(unwrappedValue);
  if (directUrl) {
    return directUrl;
  }
  return parseSupportedReaderUrl(unwrappedValue);
}

function parseSupportedReaderUrl(value) {
  const text = String(value || '').trim();
  if (text.startsWith('about:reader?')) {
    try {
      return parseHttpUrl(new URL(text).searchParams.get('url'));
    } catch {
      return '';
    }
  }

  for (const prefix of ['x-safari-reader://', 'safari-reader://']) {
    if (text.toLowerCase().startsWith(prefix)) {
      return parseHttpUrl(decodeURIComponentSafely(text.slice(prefix.length)));
    }
  }

  return '';
}

function unwrapNestedSleepUrl(value) {
  let current = String(value || '').trim();
  const seen = new Set();

  for (let depth = 0; depth < 8 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    const next = unwrapKnownSleepUrl(current);
    if (!next || next === current) {
      break;
    }
    current = String(next).trim();
  }

  return current;
}

function unwrapKnownSleepUrl(value) {
  try {
    const parsed = new URL(value);
    if (!isKnownSleepWrapper(parsed)) {
      return '';
    }

    const hash = new URLSearchParams(parsed.hash.replace(/^#/, ''));
    const legacyUrl = hash.get('url');
    if (legacyUrl) {
      return legacyUrl;
    }

    const fallback = hash.get('fallback');
    if (!fallback) {
      return '';
    }

    return JSON.parse(base64UrlDecode(fallback))?.url || '';
  } catch {
    return '';
  }
}

function isKnownSleepWrapper(parsed) {
  const protocol = parsed.protocol.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();
  const host = parsed.hostname.toLowerCase();

  if (protocol === 'file:' && pathname.endsWith('/local-sleeper.html')) {
    return true;
  }
  if ((host === '127.0.0.1' || host === 'localhost') && pathname === '/sleep') {
    return true;
  }
  return false;
}

function base64UrlEncode(value) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value, 'utf8').toString('base64url');
  }

  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value, 'base64url').toString('utf8');
  }

  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function hostnameFromUrl(url) {
  try {
    return new URL(normalizeRestorableUrl(url) || url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function isYouTubeUrl(url) {
  const host = hostnameFromUrl(url);
  return host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be';
}

export function shouldTreatYouTubeAsHighRisk(url, state = {}, settings = DEFAULT_SETTINGS) {
  return isYouTubeUrl(url) && Number(state.youtubeVideoCount ?? 0) >= Number(settings.youtubeVideoThreshold ?? 20);
}

export function mergeYouTubePageState(existingState = {}, incomingState = {}) {
  const previousCount = Math.max(0, Number(existingState.youtubeVideoCount ?? 0));
  const previousUrl = String(existingState.youtubeLastVideoUrl || '');
  const incomingCount = Math.max(0, Number(incomingState.youtubeVideoCount ?? 0));
  const incomingUrl = String(incomingState.youtubeLastVideoUrl || '');

  if (!incomingUrl) {
    return {
      youtubeVideoCount: previousCount,
      youtubeLastVideoUrl: previousUrl,
    };
  }

  if (incomingUrl === previousUrl) {
    return {
      youtubeVideoCount: previousCount,
      youtubeLastVideoUrl: previousUrl,
    };
  }

  return {
    youtubeVideoCount: Math.max(previousCount + 1, incomingCount),
    youtubeLastVideoUrl: incomingUrl,
  };
}

export function isAggressiveDomain(url, settings = DEFAULT_SETTINGS) {
  return isDomainMatched(url, settings.aggressiveList ?? []);
}

export function isPressureDomain(url, settings = DEFAULT_SETTINGS) {
  const normalizedSettings = mergeSettings(settings);
  if (isLocalSleepPageUrl(url, normalizedSettings.sleepServerUrl)) {
    return false;
  }
  return isDomainMatched(url, normalizedSettings.pressureDomains);
}

export function buildSleepDecision({ tab, state = {}, settings = DEFAULT_SETTINGS, now = Date.now(), runtimeBaseUrl = '' }) {
  const normalizedSettings = mergeSettings(settings);
  const eligibility = getTabEligibility({ tab, state, settings: normalizedSettings, runtimeBaseUrl, allowActive: false });

  if (!eligibility.eligible) {
    return { sleep: false, reason: eligibility.reason };
  }

  const lastActiveAt = Number(state.lastActiveAt ?? now);
  const inactiveMs = Math.max(0, now - lastActiveAt);

  if (shouldTreatYouTubeAsHighRisk(tab.url, state, normalizedSettings)) {
    const youtubeTimeoutMs = Number(normalizedSettings.youtubeHighRiskInactiveSeconds) * 1000;
    if (inactiveMs >= youtubeTimeoutMs) {
      return { sleep: true, reason: 'youtube-smart-cleanup' };
    }
  }

  if (isAggressiveDomain(tab.url, normalizedSettings)) {
    const aggressiveTimeoutMs = Number(normalizedSettings.aggressiveInactiveSeconds) * 1000;
    if (inactiveMs >= aggressiveTimeoutMs) {
      return { sleep: true, reason: 'aggressive-domain' };
    }
  }

  const inactivityMs = Number(normalizedSettings.inactivityMinutes) * 60_000;
  if (inactiveMs >= inactivityMs) {
    return { sleep: true, reason: 'inactive-timeout' };
  }

  return { sleep: false, reason: 'not-idle-long-enough' };
}

export function buildManualSleepDecision({ tab, state = {}, settings = DEFAULT_SETTINGS, runtimeBaseUrl = '' }) {
  return getTabEligibility({ tab, state, settings: mergeSettings(settings), runtimeBaseUrl, allowActive: true });
}

export function chooseUnloadStrategy({ tab, capabilities = {}, manual = false }) {
  if (!manual && !tab?.active && capabilities.tabsDiscard) {
    return 'native-discard';
  }

  return 'sleep-page';
}

export function getTabEligibility({ tab, state = {}, settings = DEFAULT_SETTINGS, runtimeBaseUrl = '', allowActive = false }) {
  if (!tab || typeof tab.id !== 'number') {
    return { eligible: false, reason: 'missing-tab' };
  }

  if (!tab.url) {
    return { eligible: false, reason: 'missing-url' };
  }

  if (!allowActive && tab.active) {
    return { eligible: false, reason: 'active-tab' };
  }

  if (settings.skipPinned && tab.pinned) {
    return { eligible: false, reason: 'pinned-tab' };
  }

  if (settings.skipAudible && tab.audible) {
    return { eligible: false, reason: 'audible-tab' };
  }

  if (isKnownSleepPageUrl(tab.url, settings, runtimeBaseUrl)) {
    return { eligible: false, reason: 'already-sleeping' };
  }

  if (!isUrlSleepable(tab.url)) {
    return { eligible: false, reason: 'internal-url' };
  }

  if (settings.protectDirtyForms && state.dirty) {
    return { eligible: false, reason: 'dirty-form' };
  }

  if (isAllowlisted(tab.url, settings.allowlist)) {
    return { eligible: false, reason: 'allowlisted' };
  }

  return { eligible: true, reason: 'eligible' };
}

export function isUrlSleepable(url) {
  const restorable = normalizeRestorableUrl(url);
  if (!restorable) {
    return false;
  }

  try {
    const parsed = new URL(restorable);
    return !INTERNAL_PROTOCOLS.has(parsed.protocol) && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
  } catch {
    return false;
  }
}

export function isAllowlisted(url, allowlist = []) {
  return isDomainMatched(url, allowlist);
}

export function toggleAllowlistForHost(allowlist = [], host = '') {
  const normalizedHost = String(host || '').trim().toLowerCase();
  const normalizedAllowlist = normalizeAllowlist(allowlist);
  if (!normalizedHost) {
    return { enabled: false, allowlist: normalizedAllowlist };
  }

  const targetUrl = `https://${normalizedHost}/`;
  const isEnabled = isAllowlisted(targetUrl, normalizedAllowlist);
  return setAllowlistForHost(normalizedAllowlist, normalizedHost, !isEnabled);
}

export function setAllowlistForHost(allowlist = [], host = '', enabled = true) {
  const normalizedHost = String(host || '').trim().toLowerCase();
  const normalizedAllowlist = normalizeAllowlist(allowlist);
  if (!normalizedHost) {
    return { enabled: false, allowlist: normalizedAllowlist };
  }

  const targetUrl = `https://${normalizedHost}/`;
  const isEnabled = isAllowlisted(targetUrl, normalizedAllowlist);
  if (Boolean(enabled) === isEnabled) {
    return { enabled: isEnabled, allowlist: normalizedAllowlist };
  }

  const nextAllowlist = enabled
    ? Array.from(new Set([...normalizedAllowlist, normalizedHost])).sort()
    : normalizedAllowlist.filter((entry) => !isAllowlisted(targetUrl, [entry]));

  return { enabled: Boolean(enabled), allowlist: nextAllowlist };
}

function isDomainMatched(url, patterns = []) {
  const host = hostnameFromUrl(url);
  if (!host) {
    return false;
  }

  return normalizeAllowlist(patterns).some((pattern) => {
    return domainPatternMatchesHost(pattern, host) || domainsShareYouTubeFamily(pattern, host);
  });
}

function domainPatternMatchesHost(pattern, host) {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }

  return host === pattern;
}

function domainsShareYouTubeFamily(pattern, host) {
  return isYouTubeFamilyDomain(pattern) && isYouTubeFamilyDomain(host);
}

function isYouTubeFamilyDomain(value) {
  const domain = String(value || '')
    .toLowerCase()
    .replace(/^\*\./, '')
    .replace(/^www\./, '');

  return YOUTUBE_FAMILY_DOMAINS.some((youtubeDomain) => (
    domain === youtubeDomain || domain.endsWith(`.${youtubeDomain}`)
  ));
}

export function getSleepReasonTag(reason) {
  const tags = {
    'inactive-timeout': 'idle',
    'youtube-smart-cleanup': 'youtube',
    'manual-youtube-cleanup': 'youtube',
    'aggressive-domain': 'aggressive',
    'memory-pressure': 'memory',
    'memory-guard': 'memory',
    'manual-memory-cleanup': 'memory',
    'manual-current-tab': 'manual',
    'manual-all-except-current': 'manual',
  };
  return tags[reason] ?? 'sleep';
}

export function formatSleepingTabTitle(originalTitle, reason = 'sleep') {
  const title = String(originalTitle || '').trim() || 'Спящая вкладка';
  const cleanTitle = title.replace(/^\[(?:sleep|спит)(?::[^\]]+)?\]\s*/i, '').trim() || 'Спящая вкладка';
  const tag = getSleepReasonTag(reason);
  return tag === 'sleep' ? `[sleep] ${cleanTitle}` : `[sleep: ${tag}] ${cleanTitle}`;
}

export function formatReason(reason) {
  const labels = {
    'inactive-timeout': 'неактивна дольше таймера',
    'youtube-smart-cleanup': 'очистка долгой YouTube-сессии',
    'aggressive-domain': 'домен с быстрым усыплением',
    'manual-current-tab': 'усыплено вручную',
    'manual-youtube-cleanup': 'ручная очистка YouTube',
    'manual-memory-cleanup': 'ручная очистка памяти',
    'manual-all-except-current': 'массовое усыпление вручную',
    'memory-pressure': 'очистка из-за памяти',
    'memory-guard': 'очистка монитором памяти',
    'sleep-server-unavailable': 'локальный sleep-server недоступен',
  };
  return labels[reason] ?? reason ?? 'очистка вкладки';
}
