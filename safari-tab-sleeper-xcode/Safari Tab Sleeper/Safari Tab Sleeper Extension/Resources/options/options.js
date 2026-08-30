import { DEFAULT_SETTINGS, applyProfile, normalizeAllowlist } from '../background/core.js';
import { sendRuntimeMessage } from '../shared/messaging.js';

const form = document.querySelector('#settings-form');
const status = document.querySelector('#save-status');
const restoreDefaults = document.querySelector('#restore-defaults');

async function send(type, payload = {}) {
  return sendRuntimeMessage({ type, ...payload });
}

function fillForm(settings) {
  form.profile.value = settings.profile ?? DEFAULT_SETTINGS.profile;
  form.inactivityMinutes.value = settings.inactivityMinutes;
  form.youtubeVideoThreshold.value = settings.youtubeVideoThreshold;
  form.youtubeHighRiskInactiveSeconds.value = settings.youtubeHighRiskInactiveSeconds;
  form.aggressiveInactiveSeconds.value = settings.aggressiveInactiveSeconds;
  form.restoreOnFocus.checked = settings.restoreOnFocus;
  form.powerAware.checked = settings.powerAware;
  form.requireLocalSleepServer.checked = settings.requireLocalSleepServer;
  form.skipPinned.checked = settings.skipPinned;
  form.skipAudible.checked = settings.skipAudible;
  form.protectDirtyForms.checked = settings.protectDirtyForms;
  form.allowlist.value = normalizeAllowlist(settings.allowlist).join('\n');
  form.aggressiveList.value = normalizeAllowlist(settings.aggressiveList).join('\n');
  form.pressureDomains.value = normalizeAllowlist(settings.pressureDomains).join('\n');
}

function readForm() {
  const numberOrDefault = (field, fallback) => {
    const rawValue = String(field.value ?? '').trim();
    const value = Number(rawValue);
    return rawValue && Number.isFinite(value) ? value : fallback;
  };
  return {
    profile: form.profile.value,
    inactivityMinutes: numberOrDefault(form.inactivityMinutes, DEFAULT_SETTINGS.inactivityMinutes),
    youtubeVideoThreshold: numberOrDefault(form.youtubeVideoThreshold, DEFAULT_SETTINGS.youtubeVideoThreshold),
    youtubeHighRiskInactiveSeconds: numberOrDefault(form.youtubeHighRiskInactiveSeconds, DEFAULT_SETTINGS.youtubeHighRiskInactiveSeconds),
    aggressiveInactiveSeconds: numberOrDefault(form.aggressiveInactiveSeconds, DEFAULT_SETTINGS.aggressiveInactiveSeconds),
    restoreOnFocus: form.restoreOnFocus.checked,
    powerAware: form.powerAware.checked,
    requireLocalSleepServer: form.requireLocalSleepServer.checked,
    skipPinned: form.skipPinned.checked,
    skipAudible: form.skipAudible.checked,
    protectDirtyForms: form.protectDirtyForms.checked,
    allowlist: normalizeAllowlist(form.allowlist.value),
    aggressiveList: normalizeAllowlist(form.aggressiveList.value),
    pressureDomains: normalizeAllowlist(form.pressureDomains.value),
  };
}

async function load() {
  try {
    fillForm(await send('tab-sleeper:get-settings'));
  } catch (error) {
    fillForm(DEFAULT_SETTINGS);
    status.textContent = `Не удалось загрузить настройки: ${String(error?.message ?? error)}`;
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  status.textContent = 'Сохраняю...';
  try {
    const result = await send('tab-sleeper:save-settings', { settings: readForm() });
    if (result?.ok === false) {
      throw new Error(result.reason || 'save-failed');
    }
    status.textContent = 'Сохранено.';
    setTimeout(() => {
      status.textContent = '';
    }, 1800);
  } catch (error) {
    status.textContent = `Не удалось сохранить: ${String(error?.message ?? error)}`;
  }
});

restoreDefaults.addEventListener('click', () => {
  fillForm(DEFAULT_SETTINGS);
});

form.profile.addEventListener('change', () => {
  fillForm({
    ...readForm(),
    ...applyProfile(form.profile.value),
  });
});

void load();
