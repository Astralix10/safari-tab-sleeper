import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('sleep page does not default to the extension icon', async () => {
  const html = await read('extension/sleep/sleep.html');

  assert.equal(html.includes('../icons/icon-48.svg'), false);
  assert.equal(html.includes('early-favicon.js'), true);
});

test('main extension UI is localized to Russian', async () => {
  const [manifest, popupHtml, optionsHtml, sleepHtml] = await Promise.all([
    read('extension/manifest.json').then(JSON.parse),
    read('extension/popup/popup.html'),
    read('extension/options/options.html'),
    read('extension/sleep/sleep.html'),
  ]);

  assert.equal(manifest.action.default_title, 'Усыпить вкладки');
  assert.equal(popupHtml.includes('Усыпить текущую вкладку'), true);
  assert.equal(optionsHtml.includes('name="powerAware"'), true);
  assert.equal(optionsHtml.includes('На батарее усыплять быстрее'), true);
  assert.equal(optionsHtml.includes('Настройки'), true);
  assert.equal(sleepHtml.includes('Вкладка спит'), true);
});

test('popup uses one centered allowlist switch instead of fast-sleep shortcut', async () => {
  const [popupHtml, popupCss, popupJs] = await Promise.all([
    read('extension/popup/popup.html'),
    read('extension/popup/popup.css'),
    read('extension/popup/popup.js'),
  ]);

  assert.equal(popupHtml.includes('id="add-aggressive"'), false);
  assert.equal(popupHtml.includes('Усыплять сайт быстрее'), false);
  assert.equal(popupHtml.includes('id="allowlist-toggle"'), true);
  assert.equal(popupHtml.includes('role="switch"'), true);
  assert.equal(popupCss.includes('.allowlist-row'), true);
  assert.equal(popupCss.includes('justify-self: center'), true);
  assert.equal(popupJs.includes('tab-sleeper:toggle-allowlist-current'), true);
});

test('popup replaces sleeping tabs list with memory usage and restore-all action', async () => {
  const [popupHtml, popupJs, popupCss] = await Promise.all([
    read('extension/popup/popup.html'),
    read('extension/popup/popup.js'),
    read('extension/popup/popup.css'),
  ]);

  assert.equal(popupHtml.includes('Спящие вкладки <span'), false);
  assert.equal(popupHtml.includes('id="sleeping-list"'), false);
  assert.equal(popupHtml.includes('sleeping-panel'), false);
  assert.equal(popupHtml.includes('id="memory-usage"'), true);
  assert.equal(popupHtml.includes('id="memory-details"'), true);
  assert.equal(popupHtml.includes('id="restore-all"'), true);
  assert.equal(popupHtml.includes('Разбудить все вкладки'), true);
  assert.equal(popupHtml.includes('id="free-memory-now"'), true);
  assert.equal(popupHtml.includes('Освободить память сейчас'), true);
  assert.equal(popupJs.includes('readMemoryStatus'), true);
  assert.equal(popupJs.includes('tab-sleeper:restore-all'), true);
  assert.equal(popupJs.includes('tab-sleeper:free-memory-now'), true);
  assert.equal(popupJs.includes('Спит:'), false);
  assert.equal(popupJs.includes('renderSleepingTabs'), false);
  assert.equal(popupJs.includes('Вернуть'), false);
  assert.match(popupCss, /\.actions button\s*\{[^}]*width:\s*100%/s);
  assert.match(popupCss, /\.switch-button\s*\{[^}]*width:\s*100%/s);
});

test('companion sleep page also uses English sleep tab prefix', async () => {
  const localSleeper = await read('companion/local-sleeper.html');

  assert.equal(localSleeper.includes('`[sleep]'), true);
  assert.equal(localSleeper.includes('`[sleep: ${tag}]'), true);
});

test('sleep pages auto-restore when returning to a manually slept background tab', async () => {
  const [extensionSleepJs, sleeperServer, localSleeper] = await Promise.all([
    read('extension/sleep/sleep.js'),
    read('companion/sleeper-server.py'),
    read('companion/local-sleeper.html'),
  ]);

  assert.equal(extensionSleepJs.includes("let wasHiddenAfterSleep = document.visibilityState === 'hidden';"), true);
  assert.equal(extensionSleepJs.includes('getSleepPageAutoRestoreDelay'), true);
  assert.equal(extensionSleepJs.includes("activeEntry.reason === 'manual-current-tab' && wasHiddenAfterSleep"), true);
  assert.equal(extensionSleepJs.includes("throw new Error('missing-active-tab')"), true);

  assert.equal(sleeperServer.includes("let wasHiddenAfterSleep = document.visibilityState === 'hidden';"), true);
  assert.equal(sleeperServer.includes("entry.reason === 'manual-current-tab' && wasHiddenAfterSleep"), true);
  assert.equal(sleeperServer.includes('function scheduleRestoreOnReturn()'), true);

  assert.equal(localSleeper.includes('function scheduleRestoreOnReturn()'), true);
  assert.equal(localSleeper.includes('wasHiddenAfterSleep && restorableUrl'), true);
});
