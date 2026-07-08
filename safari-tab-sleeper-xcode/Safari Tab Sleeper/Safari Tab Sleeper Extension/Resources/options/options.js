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
  return {
    profile: form.profile.value,
    inactivityMinutes: Number(form.inactivityMinutes.value),
    youtubeVideoThreshold: Number(form.youtubeVideoThreshold.value),
    youtubeHighRiskInactiveSeconds: Number(form.youtubeHighRiskInactiveSeconds.value),
    aggressiveInactiveSeconds: Number(form.aggressiveInactiveSeconds.value),
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
  fillForm(await send('tab-sleeper:get-settings'));
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  status.textContent = 'Сохраняю...';
  await send('tab-sleeper:save-settings', { settings: readForm() });
  status.textContent = 'Сохранено.';
  setTimeout(() => {
    status.textContent = '';
  }, 1800);
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

load();
