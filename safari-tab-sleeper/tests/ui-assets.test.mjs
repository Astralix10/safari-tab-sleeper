import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const readXcode = (path) => readFile(new URL(`../../safari-tab-sleeper-xcode/Safari Tab Sleeper/${path}`, import.meta.url), 'utf8');

test('sleep page does not default to the extension icon', async () => {
  const html = await read('extension/sleep/sleep.html');

  assert.equal(html.includes('../icons/icon-48.svg'), false);
  assert.equal(html.includes('early-favicon.js'), false);
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
  assert.equal(optionsHtml.includes('На батарее очищать тяжёлые вкладки быстрее'), true);
  assert.equal(optionsHtml.includes('Настройки'), true);
  assert.equal(sleepHtml.includes('Вкладка спит'), true);
});

test('popup uses one centered allowlist switch instead of fast-sleep shortcut', async () => {
  const [manifest, popupHtml, popupCss, popupJs, background, pageGuard, sleeperServer] = await Promise.all([
    read('extension/manifest.json').then(JSON.parse),
    read('extension/popup/popup.html'),
    read('extension/popup/popup.css'),
    read('extension/popup/popup.js'),
    read('extension/background/service-worker-0.2.9.js'),
    read('extension/content/page-guard.js'),
    read('companion/sleeper-server.py'),
  ]);

  assert.equal(popupHtml.includes('id="add-aggressive"'), false);
  assert.equal(popupHtml.includes('Усыплять сайт быстрее'), false);
  assert.equal(popupHtml.includes('id="allowlist-toggle"'), true);
  assert.equal(popupHtml.includes('type="checkbox"'), false);
  assert.equal(popupHtml.includes('data-enabled="false"'), true);
  assert.equal(popupHtml.includes('aria-pressed'), false);
  assert.equal(popupHtml.includes('role="switch"'), false);
  assert.equal(popupCss.includes('.allowlist-row'), true);
  assert.equal(popupCss.includes('justify-self: center'), true);
  assert.equal(popupCss.includes('pointer-events: none'), false);
  assert.equal(popupCss.includes('.switch-button[data-enabled="true"]'), true);
  assert.equal(manifest.permissions.includes('activeTab'), true);
  assert.equal(manifest.permissions.includes('scripting'), true);
  assert.equal(popupJs.includes('setCurrentSiteAllowlisted'), true);
  assert.equal(popupJs.includes('updateAllowlistToggle'), true);
  assert.equal(popupJs.includes('tab-sleeper:set-allowlist-current'), true);
  assert.equal(popupJs.includes("'/active-tab'"), false);
  assert.equal(background.includes("'/active-tab'"), true);
  assert.equal(popupJs.includes('tab-sleeper:get-memory-status'), true);
  assert.equal(popupJs.includes('settingsSchemaVersion: SETTINGS_SCHEMA_VERSION'), true);
  assert.equal(popupJs.includes('activeTabHintFromState'), true);
  assert.equal(popupJs.includes("addEventListener('click'"), true);
  assert.equal(popupJs.includes('setAllowlistToggleValue'), true);
  assert.equal(popupJs.includes('readActiveTabHint'), true);
  assert.equal(popupJs.includes('api.windows.getLastFocused({ populate: true })'), true);
  assert.equal(popupJs.includes('api.tabs.getSelected'), true);
  assert.equal(popupJs.includes('currentUrl: tab.url || fallback.currentUrl'), true);
  assert.equal(pageGuard.includes('pageUrl: location.href'), true);
  assert.equal(pageGuard.includes('tab-sleeper:get-page-info'), true);
  assert.equal(background.includes('resolveActiveTab(rawTab, state, hint)'), true);
  assert.equal(background.includes('resolveCurrentTab(hint)'), true);
  assert.equal(background.includes('api.tabs.get(hintedTabId)'), true);
  assert.equal(background.includes('api.windows.getLastFocused({ populate: true })'), true);
  assert.equal(background.includes('rememberActiveTab'), true);
  assert.equal(background.includes('lastActiveTabId'), true);
  assert.equal(background.includes('activeTabDebug'), true);
  assert.equal(background.includes('api.scripting.executeScript'), true);
  assert.equal(background.includes('setCurrentDomainAllowlisted'), true);
  assert.equal(background.includes('initializeSettingsFromCompanion'), true);
  assert.equal(background.includes('...companion.allowlist'), true);
  assert.equal(background.includes('restoredAllowlist'), true);
  assert.equal(background.includes('SETTINGS_SCHEMA_VERSION = 2'), true);
  assert.equal(background.includes('settingsSchemaVersion'), true);
  assert.equal(background.includes('reconcileCompanionSettings'), false);
  assert.equal(background.includes('void syncCompanionSettings(baseSettings)'), false);
  assert.equal(background.includes('companionSettingsSyncQueue'), true);
  assert.equal(background.includes('void syncCompanionSettings(storedSettings)'), true);
  assert.equal(background.includes('companionMutationHeaders()'), true);
  assert.equal(sleeperServer.includes('def collect_active_safari_tab'), true);
  assert.equal(sleeperServer.includes('if path == "/active-tab"'), true);
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
  assert.equal(sleeperServer.includes('function unwrapSleepUrl'), true);

  assert.equal(localSleeper.includes('function scheduleRestoreOnReturn()'), true);
  assert.equal(localSleeper.includes('function unwrapSleepUrl'), true);
  assert.equal(localSleeper.includes('wasHiddenAfterSleep && restorableUrl'), true);
});

test('memory cleanup is delegated to the protected extension eligibility path', async () => {
  const [background, pageGuard, memoryGuard, installLaunchAgent, installMenuBar, menuBarSwift, sleepCurrentScript, sleepHeavyScript, sleepAllScript] = await Promise.all([
    read('extension/background/service-worker-0.2.9.js'),
    read('extension/content/page-guard.js'),
    read('companion/memory-guard.zsh'),
    read('companion/install-launch-agent.zsh'),
    read('companion/install-menu-bar.zsh'),
    read('menubar/Sources/SafariTabSleeperMenuBar/main.swift'),
    read('companion/sleep-current-tab.applescript'),
    read('companion/sleep-inactive-youtube-tabs.applescript'),
    read('companion/sleep-all-inactive-tabs.applescript'),
  ]);

  assert.equal(background.includes('scanInFlight'), true);
  assert.equal(background.includes('pendingTabSleeps'), true);
  assert.equal(background.includes('storageMutationQueues'), true);
  assert.equal(background.includes('isTabProtectedByLatestSettings'), true);
  assert.equal(background.includes("return { ok: false, reason: 'allowlisted' };"), true);
  assert.equal(background.includes("debugActiveTab('hinted-url-unique-match'"), true);
  assert.equal(background.includes('sleep-navigation-failed'), true);
  assert.equal(pageGuard.includes('window.setInterval(handleNavigationChange, 1000)'), false);
  assert.equal(memoryGuard.includes('/cleanup-request'), true);
  assert.equal(memoryGuard.includes('osascript "$SCRIPT_DIR/sleep-inactive-youtube-tabs.applescript"'), false);
  assert.equal(memoryGuard.includes('http://127.0.0.1:17654/sleep'), true);
  assert.equal(installLaunchAgent.includes('settings-ready'), true);
  assert.equal(installLaunchAgent.includes('if [[ ! -f "$RUNTIME_DIR/allowlist.txt" ]]; then'), true);
  assert.equal(installLaunchAgent.includes('rm -f "$RUNTIME_DIR/settings-ready"'), true);
  assert.equal(installLaunchAgent.includes('rm -f "$RUNTIME_DIR/trusted-extension-origin.txt"'), true);
  assert.equal(installLaunchAgent.includes('pkill -f "$RUNTIME_DIR/sleeper-server.py"'), true);
  assert.equal(installMenuBar.includes('allowlist.txt'), true);
  assert.equal(menuBarSwift.includes('sleepServerURL'), true);
  assert.equal(menuBarSwift.includes('scriptPath("allowlist.txt")'), true);
  assert.equal(sleepCurrentScript.includes('sleepPageBaseURL'), true);
  assert.equal(sleepCurrentScript.includes('isAllowlistedURL'), true);
  assert.equal(sleepCurrentScript.includes('reason=allowlisted'), true);
  assert.equal(sleepCurrentScript.includes('reason=already-sleeping'), true);
  assert.equal(sleepHeavyScript.includes('reason=extension-required'), true);
  assert.equal(sleepAllScript.includes('reason=extension-required'), true);
});

test('popup trusts the front Safari tab over stale extension state', async () => {
  const popup = await read('extension/popup/popup.js');
  const companionLookup = popup.indexOf('const companionTab = await readCompanionActiveTab');
  const extensionLookup = popup.indexOf("api.tabs.query({ active: true, currentWindow: true })");

  assert.equal(companionLookup >= 0, true);
  assert.equal(extensionLookup > companionLookup, true);
  assert.equal(popup.includes('hostnameFromUrl(hintedUrl) || state.currentHost'), true);
  assert.equal(popup.includes('защита от усыпления включена'), true);
  assert.equal(popup.includes('sleepCurrentWithFallback'), true);
});

test('companion mutations require the extension secret and server logging is bounded', async () => {
  const [auth, server, memoryGuard] = await Promise.all([
    read('extension/shared/companion-auth.js'),
    read('companion/sleeper-server.py'),
    read('companion/memory-guard.zsh'),
  ]);

  assert.equal(auth.includes('COMPANION_MUTATION_TOKEN'), true);
  assert.equal(auth.includes("from './companion-token.js'"), true);
  assert.doesNotMatch(auth, /['"][0-9a-f]{64}['"]/);
  assert.equal(server.includes('hmac.compare_digest'), true);
  assert.equal(server.includes('unauthorized-mutation'), true);
  assert.equal(server.includes('invalid-json'), true);
  assert.equal(server.includes('sys.stderr.write'), false);
  assert.equal(server.includes('except (BrokenPipeError, ConnectionResetError)'), true);
  assert.equal(memoryGuard.includes('rotate_log_if_needed'), true);
});

test('release host app reports native errors and activates Safari settings', async () => {
  const [viewController, hostScript, infoPlist, project] = await Promise.all([
    readXcode('Safari Tab Sleeper/ViewController.swift'),
    readXcode('Safari Tab Sleeper/Resources/Script.js'),
    readXcode('Safari Tab Sleeper/Info.plist'),
    readXcode('Safari Tab Sleeper.xcodeproj/project.pbxproj'),
  ]);

  assert.equal(viewController.includes('self.showError(error.localizedDescription'), true);
  assert.equal(viewController.includes('resolveCompanionExtensionState'), true);
  assert.equal(viewController.includes('resolveCompanionExtensionState(error: nil, in: webView)'), true);
  assert.equal(viewController.includes('/extension-state'), true);
  assert.equal(viewController.includes('if state.isEnabled'), true);
  assert.equal(viewController.includes('showExtensionState(enabled: true'), true);
  assert.equal(viewController.includes('safari?.activate(options:'), true);
  assert.equal(viewController.includes('if let error'), true);
  assert.equal(hostScript.includes('function showError(message)'), true);
  assert.equal(infoPlist.includes('NSAppleEventsUsageDescription'), true);
  assert.equal(infoPlist.includes('NSAllowsLocalNetworking'), true);
  assert.equal(project.includes('CODE_SIGN_INJECT_BASE_ENTITLEMENTS = NO;'), true);
  assert.equal(project.includes('Safari Tab Sleeper.entitlements'), true);
});

test('worker rejects invalid YouTube reset tab IDs and protects every active window tab', async () => {
  const background = await read('extension/background/service-worker-0.2.9.js');

  assert.equal(background.includes('Number.isInteger(targetTabId)'), true);
  assert.equal(background.includes('if (tab.id == null || tab.active)'), true);
  assert.equal(background.includes("reason: 'already-sleeping'"), true);
  assert.equal(background.includes("'/sleep-current'"), true);
  assert.equal(background.includes("'/heartbeat'"), true);
  assert.equal(background.includes('syncExtensionHeartbeat'), true);
});
