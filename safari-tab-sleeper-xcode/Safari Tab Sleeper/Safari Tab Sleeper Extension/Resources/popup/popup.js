import { runtimeApi as api, sendRuntimeMessage } from '../shared/messaging.js';
import { isAllowlisted } from '../background/core.js';

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

async function send(type, payload = {}) {
  return sendRuntimeMessage({ type, ...payload });
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
  try {
    const url = new URL(settings.sleepServerUrl || 'http://127.0.0.1:17654/sleep');
    url.pathname = '/memory';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return 'http://127.0.0.1:17654/memory';
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

function renderMemoryStatus(status) {
  if (!status?.ok) {
    elements.memoryUsage.textContent = 'Недоступно';
    elements.memoryDetails.textContent = 'Локальный companion-монитор не ответил.';
    return;
  }

  elements.memoryUsage.textContent = formatMemory(status.totalMb);
  elements.memoryDetails.textContent = `Пик процесса ${formatMemory(status.maxMb)} · системный swap ${formatMemory(status.swapUsedMb)}`;
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
  elements.tabMeta.textContent = state.isSleeping
    ? `Причина: ${state.reasonLabel}`
    : `${hostFromUrl(tab.url)} · видео YouTube в этой вкладке: ${youtubeCount}`;

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
  elements.allowlistToggle.disabled = !state.currentHost || state.isSleeping;
  elements.allowlistToggle.setAttribute('aria-checked', String(isCurrentHostAllowlisted(state)));
  elements.powerStatus.textContent = state.powerStatus?.label || 'Питание: неизвестно';
}

async function refresh() {
  try {
    const state = await send('tab-sleeper:get-popup-state');
    render(state);
    try {
      renderMemoryStatus(await readMemoryStatus(state.settings));
    } catch {
      renderMemoryStatus(null);
    }
  } catch (error) {
    elements.statusTitle.textContent = 'Не удалось прочитать вкладку';
    elements.tabTitle.textContent = 'Safari отклонил запрос расширения.';
    elements.tabMeta.textContent = String(error?.message ?? error);
  }
}

async function runAction(button, action) {
  const canChangeLabel = button.tagName !== 'SELECT' && !button.classList.contains('switch-button');
  const original = button.textContent;
  let refreshed = false;
  button.disabled = true;
  if (canChangeLabel) {
    button.textContent = 'Работаю...';
  }
  try {
    const result = await action();
    if (result?.ok === false) {
      elements.tabMeta.textContent = `Пропущено: ${result.reason}`;
    }
    await refresh();
    refreshed = true;
  } finally {
    if (!refreshed) {
      button.disabled = false;
    }
    if (canChangeLabel) {
      button.textContent = original;
    }
  }
}

elements.sleepCurrent.addEventListener('click', () => {
  runAction(elements.sleepCurrent, () => send('tab-sleeper:sleep-current'));
});

elements.restoreCurrent.addEventListener('click', () => {
  const token = currentState?.sleepEntry?.token;
  const tabId = currentState?.tab?.id;
  if (!token || !tabId) {
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
  runAction(elements.allowlistToggle, () => send('tab-sleeper:toggle-allowlist-current'));
});

elements.resetYouTube.addEventListener('click', () => {
  runAction(elements.resetYouTube, () => send('tab-sleeper:reset-youtube-counter'));
});

elements.profile.addEventListener('change', () => {
  runAction(elements.profile, () => send('tab-sleeper:set-profile', { profile: elements.profile.value }));
});

elements.openOptions.addEventListener('click', () => {
  api.runtime.openOptionsPage();
});

refresh();
