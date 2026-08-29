import { runtimeApi as api, sendRuntimeMessage } from '../shared/messaging.js';
import {
  hostnameFromUrl,
  isAllowlisted,
  mergeSettings,
  setAllowlistForHost,
} from '../background/core.js';

const SETTINGS_SCHEMA_VERSION = 2;

const elements = {
  statusTitle: document.querySelector('#status-title'),
  badge: document.querySelector('#badge'),
  tabTitle: document.querySelector('#tab-title'),
  tabMeta: document.querySelector('#tab-meta'),
  profile: document.querySelector('#profile'),
  sleepCurrent: document.querySelector('#sleep-current'),
  restoreCurrent: document.querySelector('#restore-current'),
  sleepAllExceptCurrent: document.querySelector('#sleep-all-except-current'),
  restoreAll: document.querySelector('#restore-all'),
  sleepYouTube: document.querySelector('#sleep-youtube'),
  freeMemoryNow: document.querySelector('#free-memory-now'),
  allowlistToggle: document.querySelector('#allowlist-toggle'),
  resetYouTube: document.querySelector('#reset-youtube'),
  memoryUsage: document.querySelector('#memory-usage'),
  memoryDetails: document.querySelector('#memory-details'),
  powerStatus: document.querySelector('#power-status'),
  openOptions: document.querySelector('#open-options'),
};

let currentState = null;

function setAllowlistToggleValue(enabled) {
  const value = Boolean(enabled);
  elements.allowlistToggle.dataset.enabled = String(value);
  elements.allowlistToggle.setAttribute('aria-pressed', String(value));
}

function getAllowlistToggleValue() {
  return elements.allowlistToggle.dataset.enabled === 'true';
}

async function send(type, payload = {}) {
  return sendRuntimeMessage({ type, ...payload });
}

function activeTabHintFromState(state = currentState) {
  return {
    currentTabId: state?.tab?.id,
    currentUrl: state?.tab?.url || state?.state?.pageUrl || '',
    currentTitle: state?.tab?.title || state?.state?.pageTitle || '',
  };
}

async function readActiveTabHint(fallbackState = currentState) {
  const fallback = activeTabHintFromState(fallbackState);

  try {
    const companionTab = await readCompanionActiveTab(fallbackState?.settings);
    if (companionTab?.url) {
      let matchingTab = null;
      try {
        const tabs = await api.tabs.query({});
        matchingTab = tabs.find((candidate) => candidate.url === companionTab.url) ?? null;
      } catch {
        // The URL from the front Safari window is still authoritative for the switch.
      }

      return {
        currentTabId: matchingTab?.id,
        currentUrl: companionTab.url,
        currentTitle: companionTab.title || matchingTab?.title || fallback.currentTitle,
        source: 'companion',
      };
    }
  } catch {
    // Fall back to Safari WebExtension APIs while the companion is restarting.
  }

  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (tab?.id != null) {
      return {
        currentTabId: tab.id,
        currentUrl: tab.url || fallback.currentUrl,
        currentTitle: tab.title || fallback.currentTitle,
      };
    }
  } catch {
    // Safari popovers are not always associated with currentWindow.
  }

  try {
    const window = await api.windows.getLastFocused({ populate: true });
    const tab = window?.tabs?.find((candidate) => candidate.active);
    if (tab?.id != null) {
      return {
        currentTabId: tab.id,
        currentUrl: tab.url || fallback.currentUrl,
        currentTitle: tab.title || fallback.currentTitle,
      };
    }
  } catch {
    // Keep the last state when Safari withholds focused-window details.
  }

  if (api.tabs.getSelected) {
    try {
      const tab = await api.tabs.getSelected();
      if (tab?.id != null) {
        return {
          currentTabId: tab.id,
          currentUrl: tab.url || fallback.currentUrl,
          currentTitle: tab.title || fallback.currentTitle,
        };
      }
    } catch {
      // Safari keeps this legacy Chromium API on some releases only.
    }
  }

  return fallback;
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'эта вкладка';
  }
}

function isCurrentHostAllowlisted(state) {
  const host = state.currentHost;
  if (!host) {
    return false;
  }

  return isAllowlisted(`https://${host}/`, state.settings?.allowlist ?? []);
}

function formatMemory(mb) {
  const value = Number(mb ?? 0);
  if (!Number.isFinite(value) || value <= 0) {
    return '0 МБ';
  }

  if (value >= 1024) {
    const formatted = (value / 1024).toFixed(value >= 10 * 1024 ? 0 : 1).replace('.', ',');
    return `${formatted} ГБ`;
  }

  return `${Math.round(value)} МБ`;
}

function memoryEndpointFromSettings(settings = {}) {
  return companionEndpointFromSettings(settings, '/memory');
}

function companionEndpointFromSettings(settings = {}, pathname = '/') {
  try {
    const url = new URL(settings.sleepServerUrl || 'http://127.0.0.1:17654/sleep');
    url.pathname = pathname;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return `http://127.0.0.1:17654${pathname}`;
  }
}

async function readCompanionActiveTab(settings = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(companionEndpointFromSettings(settings, '/active-tab'), {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const result = await response.json();
    return result?.ok && hostnameFromUrl(result.url) ? result : null;
  } finally {
    clearTimeout(timeout);
  }
}

async function readStoredSettings(fallback = {}) {
  try {
    const stored = await api.storage.local.get('settings');
    return mergeSettings(stored.settings ?? fallback);
  } catch {
    return mergeSettings(fallback);
  }
}

async function enrichPopupState(state) {
  const [hint, settings] = await Promise.all([
    readActiveTabHint(state),
    readStoredSettings(state.settings),
  ]);
  const hintedUrl = hint.currentUrl || '';
  const currentHost = hostnameFromUrl(hintedUrl) || state.currentHost;
  if (!currentHost) {
    return { ...state, settings };
  }

  return {
    ...state,
    settings,
    currentHost,
    tab: {
      ...(state.tab ?? {}),
      id: hint.currentTabId ?? state.tab?.id,
      url: hintedUrl || state.tab?.url,
      title: hint.currentTitle || state.tab?.title || hintedUrl,
    },
    activeTabDebug: {
      ...(state.activeTabDebug ?? {}),
      source: hint.source || state.activeTabDebug?.source || 'popup',
    },
  };
}

async function setCurrentSiteAllowlisted(enabled) {
  const hint = await readActiveTabHint();
  const host = hostnameFromUrl(hint.currentUrl || currentState?.tab?.url);
  if (!host) {
    return { ok: false, reason: 'missing-domain' };
  }

  const settings = await readStoredSettings(currentState?.settings);
  const result = setAllowlistForHost(settings.allowlist ?? [], host, enabled);
  const nextSettings = mergeSettings({ ...settings, allowlist: result.allowlist });
  await api.storage.local.set({
    settings: nextSettings,
    settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
  });

  try {
    await send('tab-sleeper:set-allowlist-current', { ...hint, enabled });
  } catch {
    // Direct storage remains authoritative if Safari is restarting the worker.
  }

  currentState = {
    ...currentState,
    settings: nextSettings,
    currentHost: host,
  };
  return { ok: true, enabled: result.enabled, domain: host };
}

async function updateAllowlistToggle(enabled) {
  const previousValue = !enabled;
  elements.allowlistToggle.disabled = true;
  try {
    const result = await setCurrentSiteAllowlisted(enabled);
    if (!result.ok) {
      setAllowlistToggleValue(previousValue);
      elements.tabMeta.textContent = `Не удалось сохранить: ${result.reason}`;
      return;
    }

    setAllowlistToggleValue(result.enabled);
    elements.tabMeta.textContent = result.enabled
      ? `${result.domain} · сайт не будет усыпляться`
      : `${result.domain} · обычный режим усыпления`;
  } catch (error) {
    setAllowlistToggleValue(previousValue);
    elements.tabMeta.textContent = `Не удалось сохранить: ${String(error?.message ?? error)}`;
  } finally {
    elements.allowlistToggle.disabled = false;
  }
}

async function readMemoryStatus(settings = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 700);
  try {
    const response = await fetch(memoryEndpointFromSettings(settings), {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function readPowerStatus(settings = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(companionEndpointFromSettings(settings, '/power'), {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function sleepCurrentWithFallback() {
  return send('tab-sleeper:sleep-current', await readActiveTabHint());
}

function renderMemoryStatus(status) {
  if (!status?.ok) {
    elements.memoryUsage.textContent = 'Недоступно';
    elements.memoryDetails.textContent = 'Локальный companion-монитор не ответил.';
    return;
  }

  elements.memoryUsage.textContent = formatMemory(status.totalMb);
  elements.memoryDetails.textContent = `Пик процесса ${formatMemory(status.maxMb)} · системный swap ${formatMemory(status.swapUsedMb)}`;
}

function renderPowerStatus(status) {
  elements.powerStatus.textContent = status?.ok && status.label
    ? status.label
    : 'Питание: недоступно';
}

function render(state) {
  currentState = state;
  const tab = state.tab ?? {};
  const youtubeCount = Number(state.state?.youtubeVideoCount ?? 0);
  const threshold = Number(state.settings?.youtubeVideoThreshold ?? 20);
  const isHot = youtubeCount >= threshold;
  const sleepingCount = Number(state.sleepingTabs?.length ?? 0);

  elements.statusTitle.textContent = state.isSleeping ? 'Вкладка спит' : 'Готово к очистке';
  elements.badge.hidden = !isHot;
  elements.badge.textContent = isHot ? 'YouTube горячий' : '';
  elements.badge.classList.toggle('hot', isHot);
  elements.profile.value = state.settings?.profile ?? 'balanced';
  elements.tabTitle.textContent = state.isSleeping
    ? state.sleepEntry?.title || 'Спящая вкладка'
    : tab.title || hostFromUrl(tab.url);
  const protectedFromSleep = !state.isSleeping && isCurrentHostAllowlisted(state);
  elements.tabMeta.textContent = state.isSleeping
    ? `Причина: ${state.reasonLabel}`
    : protectedFromSleep
      ? `${hostFromUrl(tab.url)} · защита от усыпления включена`
      : `${hostFromUrl(tab.url)} · видео YouTube в этой вкладке: ${youtubeCount}`;
  if (!state.isSleeping && !state.currentHost) {
    const debug = state.activeTabDebug ?? {};
    elements.tabMeta.textContent = `Safari не передал адрес · ${debug.source || 'unknown'} · id ${debug.tabId ?? 'нет'} · URL ${debug.tabUrl ? 'есть' : 'нет'} · state ${debug.statePageUrl || debug.stateUrl ? 'есть' : 'нет'}`;
  }

  elements.sleepCurrent.hidden = state.isSleeping;
  elements.restoreCurrent.hidden = !state.isSleeping;
  elements.sleepCurrent.disabled = false;
  elements.restoreCurrent.disabled = false;
  elements.sleepAllExceptCurrent.disabled = false;
  elements.sleepYouTube.disabled = false;
  elements.freeMemoryNow.disabled = false;
  elements.restoreAll.disabled = sleepingCount === 0;
  elements.profile.disabled = false;
  elements.resetYouTube.disabled = youtubeCount === 0;
  elements.allowlistToggle.disabled = state.isSleeping;
  setAllowlistToggleValue(isCurrentHostAllowlisted(state));
  renderPowerStatus(state.powerStatus);
}

async function refresh() {
  try {
    const backgroundState = await send('tab-sleeper:get-popup-state', await readActiveTabHint());
    const state = await enrichPopupState(backgroundState);
    render(state);
    const [memoryResult, powerResult] = await Promise.allSettled([
      readMemoryStatus(state.settings),
      readPowerStatus(state.settings),
    ]);
    renderMemoryStatus(memoryResult.status === 'fulfilled' ? memoryResult.value : null);
    renderPowerStatus(powerResult.status === 'fulfilled' ? powerResult.value : null);
  } catch (error) {
    elements.statusTitle.textContent = 'Не удалось прочитать вкладку';
    elements.tabTitle.textContent = 'Safari отклонил запрос расширения.';
    elements.tabMeta.textContent = String(error?.message ?? error);
  }
}

async function runAction(button, action) {
  const canChangeLabel = button.tagName === 'BUTTON';
  const original = button.textContent;
  let refreshed = false;
  button.disabled = true;
  if (canChangeLabel) {
    button.textContent = 'Работаю...';
  }
  try {
    const result = await action();
    await refresh();
    refreshed = true;
    if (result?.ok === false) {
      elements.tabMeta.textContent = `Действие не выполнено: ${formatActionReason(result.reason)}`;
    }
  } catch (error) {
    elements.tabMeta.textContent = `Ошибка: ${String(error?.message ?? error)}`;
  } finally {
    if (!refreshed) {
      button.disabled = false;
    }
    if (canChangeLabel) {
      button.textContent = original;
    }
  }
}

function formatActionReason(reason) {
  const labels = {
    allowlisted: 'для этого сайта включена защита от усыпления',
    'already-sleeping': 'вкладка уже спит',
    'dirty-form': 'на странице есть несохранённые данные',
    'missing-active-tab': 'Safari не передал активную вкладку',
    'sleep-server-unavailable': 'локальный companion недоступен',
    'unsupported-url': 'эту страницу нельзя усыпить',
  };
  return labels[reason] || String(reason || 'неизвестная причина');
}

elements.sleepCurrent.addEventListener('click', () => {
  runAction(elements.sleepCurrent, sleepCurrentWithFallback);
});

elements.restoreCurrent.addEventListener('click', () => {
  const token = currentState?.sleepEntry?.token;
  const tabId = currentState?.tab?.id;
  if (!token || tabId == null) {
    return;
  }
  runAction(elements.restoreCurrent, () => send('tab-sleeper:restore', { token, tabId }));
});

elements.sleepYouTube.addEventListener('click', () => {
  runAction(elements.sleepYouTube, () => send('tab-sleeper:sleep-inactive-youtube'));
});

elements.sleepAllExceptCurrent.addEventListener('click', () => {
  runAction(elements.sleepAllExceptCurrent, () => send('tab-sleeper:sleep-all-except-current'));
});

elements.restoreAll.addEventListener('click', () => {
  runAction(elements.restoreAll, () => send('tab-sleeper:restore-all'));
});

elements.freeMemoryNow.addEventListener('click', () => {
  runAction(elements.freeMemoryNow, () => send('tab-sleeper:free-memory-now'));
});

elements.allowlistToggle.addEventListener('click', () => {
  const enabled = !getAllowlistToggleValue();
  setAllowlistToggleValue(enabled);
  void updateAllowlistToggle(enabled);
});

elements.resetYouTube.addEventListener('click', () => {
  runAction(elements.resetYouTube, async () => send('tab-sleeper:reset-youtube-counter', await readActiveTabHint()));
});

elements.profile.addEventListener('change', () => {
  runAction(elements.profile, () => send('tab-sleeper:set-profile', { profile: elements.profile.value }));
});

elements.openOptions.addEventListener('click', () => {
  api.runtime.openOptionsPage();
});

refresh();
