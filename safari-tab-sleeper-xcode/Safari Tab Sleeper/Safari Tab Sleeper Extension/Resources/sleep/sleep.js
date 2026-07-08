import {
  decodeSleepFallback,
  formatSleepingTabTitle,
  getSleepPageAutoRestoreDelay,
  getSleepingTabIconUrl,
  normalizeRestorableUrl,
} from '../background/core.js';
import { runtimeApi as api, sendRuntimeMessage } from '../shared/messaging.js';

const params = new URLSearchParams(location.search);
const token = params.get('token');
const fallbackEntry = decodeSleepFallback(location.hash);
let activeEntry = null;
let restoreInFlight = false;
let wasHiddenAfterSleep = document.visibilityState === 'hidden';

const title = document.querySelector('#title');
const details = document.querySelector('#details');
const restore = document.querySelector('#restore');
const directLink = document.querySelector('#direct-link');
const favicon = document.querySelector('#favicon');

async function send(type, payload = {}) {
  return sendRuntimeMessage({ type, ...payload });
}

function formatTime(timestamp) {
  if (!timestamp) {
    return 'только что';
  }
  return new Date(timestamp).toLocaleString('ru-RU');
}

async function load() {
  if (!token) {
    title.textContent = 'Не найден токен сна';
    details.textContent = 'Не удалось найти исходный URL.';
    restore.disabled = true;
    return;
  }

  let entry = null;
  try {
    entry = await send('tab-sleeper:get-sleep-entry', { token });
  } catch {
    entry = null;
  }
  entry ||= fallbackEntry;

  if (!entry) {
    title.textContent = 'Запись о спящей вкладке устарела';
    details.textContent = 'Расширение больше не хранит исходный URL.';
    restore.disabled = true;
    return;
  }

  activeEntry = entry;
  document.title = formatSleepingTabTitle(entry.title, entry.reason);
  const iconUrl = getSleepingTabIconUrl({ pageUrl: entry.url, favIconUrl: entry.favIconUrl });
  if (iconUrl) {
    favicon.href = iconUrl;
  }
  title.textContent = entry.title || 'Спящая вкладка';
  details.textContent = `Выгружено: ${formatTime(entry.sleptAt)}. Исходный URL: ${entry.url}`;
  const restorableUrl = normalizeRestorableUrl(entry.url);
  directLink.href = restorableUrl || entry.url;
  directLink.hidden = false;
  scheduleAutoRestore();
}

function restoreWithLocationFallback() {
  const restorableUrl = normalizeRestorableUrl(activeEntry?.url);
  if (!restorableUrl) {
    return false;
  }

  location.replace(restorableUrl);
  return true;
}

async function restoreNow() {
  if (!activeEntry || restoreInFlight) {
    return;
  }

  restoreInFlight = true;
  restore.disabled = true;
  restore.textContent = 'Восстанавливаю...';
  let result = null;
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error('missing-active-tab');
    }
    result = await send('tab-sleeper:restore', { token, tabId: tab.id });
  } catch {
    result = { ok: false, reason: 'message-failed' };
  }

  if (!result?.ok) {
    if (restoreWithLocationFallback()) {
      return;
    }

    restore.disabled = false;
    restore.textContent = 'Восстановить вкладку';
    details.textContent = `Не удалось восстановить автоматически: ${result?.reason ?? 'неизвестная ошибка'}`;
    restoreInFlight = false;
  }
}

function scheduleAutoRestore() {
  if (!activeEntry || document.visibilityState !== 'visible') {
    return;
  }

  if (activeEntry.reason === 'manual-current-tab' && wasHiddenAfterSleep) {
    window.setTimeout(restoreNow, 150);
    return;
  }

  const autoRestoreDelay = getSleepPageAutoRestoreDelay({ entry: activeEntry });
  if (autoRestoreDelay === null) {
    return;
  }

  window.setTimeout(() => {
    if (document.visibilityState === 'visible') {
      restoreNow();
    }
  }, autoRestoreDelay + 150);
}

restore.addEventListener('click', async () => {
  await restoreNow();
});

window.addEventListener('focus', scheduleAutoRestore);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    wasHiddenAfterSleep = true;
    return;
  }

  scheduleAutoRestore();
});

load();
