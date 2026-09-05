import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, SourceTextModule } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { DEFAULT_SETTINGS, mergeSettings, buildLocalSleepPageUrl } from '../extension/background/core.js';

const workerSource = await readFile(new URL('../extension/background/service-worker-0.2.9.js', import.meta.url), 'utf8');
const coreSource = await readFile(new URL('../extension/background/core.js', import.meta.url), 'utf8');
const authSource = await readFile(new URL('../extension/shared/companion-auth.js', import.meta.url), 'utf8');
const clone = (value) => structuredClone(value);
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(setImmediate); };
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, async emit(...args) { for (const fn of this.listeners) await fn(...args); await flush(); } });
const ordinary = (id, extra = {}) => ({ id, windowId: 1, active: false, pinned: false, audible: false, status: 'complete', url: `https://example${id}.com/`, title: `Tab ${id}`, ...extra });

async function worker(t, initialTabs, customSettings = {}) {
  const tabs = new Map(initialTabs.map((tab) => [tab.id, clone(tab)]));
  let now = 1_000_000;
  const store = { settings: mergeSettings(customSettings), settingsSchemaVersion: 2, sleepingTabs: {}, tabStates: {} };
  const updates = [];
  const archive = new Map();
  const timers = new Map();
  let nextTimer = 0;
  const hooks = {};
  const guards = new Map();
  const browser = {
    runtime: { getURL: (path) => `safari-web-extension://test/${path.replace(/^\//, '')}`, onMessage: event(), onStartup: event(), onInstalled: event() },
    alarms: { create() {}, onAlarm: event() },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: event(), getLastFocused: async () => ({ id: 1, tabs: clone([...tabs.values()].filter((tab) => tab.windowId === 1)) }) },
    storage: { local: {
      async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => key in store).map((key) => [key, clone(store[key])])); },
      async set(value) { Object.assign(store, clone(value)); },
    } },
    tabs: {
      onActivated: event(), onUpdated: event(), onRemoved: event(),
      async get(id) { await hooks.get?.(id); if (!tabs.has(id)) throw new Error('missing-tab'); return clone(tabs.get(id)); },
      async query(query) { return clone([...tabs.values()].filter((tab) => (query.active == null || tab.active === query.active) && (query.windowId == null || tab.windowId === query.windowId))); },
      async update(id, props) { await hooks.update?.(id, props); if (!tabs.has(id)) throw new Error('missing-tab'); updates.push({ id, ...props }); Object.assign(tabs.get(id), props); return clone(tabs.get(id)); },
      async sendMessage(id) { return guards.get(id)?.[0]?.result; },
    },
    scripting: { async executeScript({ target }) {
      await hooks.guard?.(target.tabId);
      return clone(guards.get(target.tabId) ?? [{ frameId: 0, result: { dirty: false, mediaPlaying: false, pageUrl: tabs.get(target.tabId)?.url } }]);
    } },
  };
  const context = createContext({
    browser, URL, URLSearchParams, AbortController, TextEncoder, TextDecoder, Buffer, crypto: webcrypto,
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    async fetch(rawUrl, options = {}) {
      const url = new URL(rawUrl);
      const body = options.body ? JSON.parse(options.body) : {};
      const override = await hooks.fetch?.(url.pathname, body, options);
      if (override) return override;
      let result = { ok: true };
      if (url.pathname === '/power') result = { ok: true, source: 'power' };
      if (url.pathname === '/cleanup-request') result = { ok: true, pending: false };
      if (url.pathname === '/archive-entry') {
        if (body.entry) archive.set(body.entry.token, clone(body.entry));
        if (body.action === 'delete') archive.delete(body.token);
        result = { ok: true, entry: body.entry ?? clone(archive.get(url.searchParams.get('token'))) };
      }
      return { ok: true, json: async () => result };
    },
  });
  const core = new SourceTextModule(coreSource, { context });
  const auth = new SourceTextModule(authSource, { context });
  await auth.link(() => new SourceTextModule("export const COMPANION_MUTATION_TOKEN = 'test-worker-token';", { context }));
  const module = new SourceTextModule(workerSource, { context });
  await module.link((specifier) => specifier === './core.js' ? core : auth);
  await module.evaluate();
  await flush();
  const send = (type, payload = {}, sender = {}) => new Promise((resolve) => {
    browser.runtime.onMessage.listeners[0]({ type: `tab-sleeper:${type}`, ...payload }, sender, (result) => resolve(clone(result)));
  });
  const age = (id, ms = 300_000) => { store.tabStates[id].lastActiveAt = now - ms; };
  const scan = async () => { await browser.alarms.onAlarm.emit({ name: 'tab-sleeper-scan' }); };
  t.after(() => timers.clear());
  return { tabs, store, updates, archive, guards, hooks, browser, timers, send, age, scan, advance(ms) { now += ms; } };
}

test('automatic scan sleeps at five minutes and skips a live unique media tab', async (t) => {
  const w = await worker(t, [ordinary(1, { active: true }), ordinary(2), ordinary(3)], { profile: 'aggressive' });
  w.age(2, 299_999); w.age(3);
  w.guards.set(3, [{ frameId: 0, result: { dirty: false, mediaPlaying: true } }]);
  await w.scan();
  assert.equal(w.updates.length, 0);
  w.advance(1); await w.scan();
  assert.deepEqual(w.updates.map((update) => update.id), [2]);
  assert.equal(w.archive.size, 1);
});

test('cached playing media does not prevent sleeping after playback stops', async (t) => {
  const w = await worker(t, [ordinary(2)], { profile: 'aggressive' });
  w.age(2); w.store.tabStates[2].mediaPlaying = true;
  await w.scan();
  assert.equal(w.updates.length, 1);
});

test('five minutes start when leaving the tab, using persisted active state', async (t) => {
  const w = await worker(t, [ordinary(1, { active: true }), ordinary(2)], { profile: 'aggressive' });
  w.advance(59_000);
  w.tabs.get(1).active = false; w.tabs.get(2).active = true;
  await w.browser.tabs.onActivated.emit({ tabId: 2, windowId: 1 });
  w.advance(299_999); await w.scan();
  assert.equal(w.updates.length, 0);
  w.advance(1); await w.scan();
  assert.deepEqual(w.updates.map((update) => update.id), [1]);
});

test('companion GET requests authenticate when Safari omits Origin', async (t) => {
  const w = await worker(t, [ordinary(1, { active: true })]);
  w.hooks.fetch = async (path, body, options) => {
    if (path !== '/memory') return;
    assert.equal(options.headers['x-safari-tab-sleeper-token'], 'test-worker-token');
    assert.equal(options.headers['x-safari-tab-sleeper-native'], '1');
    return { ok: true, json: async () => ({ ok: true, totalMb: 1234 }) };
  };
  assert.deepEqual(await w.send('get-memory-status'), { ok: true, totalMb: 1234 });
});

for (const change of ['active', 'pinned', 'allowlist', 'url', 'dirty']) {
  test(`sleep is cancelled if ${change} changes during archive preparation`, async (t) => {
    const w = await worker(t, [ordinary(2)], { profile: 'aggressive' });
    w.age(2);
    w.hooks.fetch = async (path, body) => {
      if (path !== '/archive-entry' || !body.entry) return;
      if (change === 'active') w.tabs.get(2).active = true;
      if (change === 'pinned') w.tabs.get(2).pinned = true;
      if (change === 'url') w.tabs.get(2).url = 'https://new.example/';
      if (change === 'allowlist') w.store.settings.allowlist = ['example2.com'];
      if (change === 'dirty') w.guards.set(2, [{ frameId: 0, result: { dirty: true, mediaPlaying: false } }]);
    };
    await w.scan();
    assert.equal(w.updates.length, 0);
    assert.equal(Object.keys(w.store.sleepingTabs).length, 0);
    assert.equal(w.archive.size, 0);
  });
}

test('archive failure leaves the original page open', async (t) => {
  const w = await worker(t, [ordinary(2)], { profile: 'aggressive' }); w.age(2);
  w.hooks.fetch = async (path, body) => path === '/archive-entry' && body.entry ? { ok: false } : null;
  await w.scan();
  assert.equal(w.updates.length, 0);
});

test('failed navigation rolls back the recovery record', async (t) => {
  const w = await worker(t, [ordinary(2)], { profile: 'aggressive' }); w.age(2);
  w.hooks.update = async () => { throw new Error('closed'); };
  await w.scan();
  assert.equal(Object.keys(w.store.sleepingTabs).length, 0);
  assert.equal(w.archive.size, 0);
});

test('embedded media protects its only domain tab', async (t) => {
  const w = await worker(t, [ordinary(2)], { profile: 'aggressive' }); w.age(2);
  w.guards.set(2, [{ frameId: 0, result: { dirty: false, mediaPlaying: false } }, { frameId: 7, result: { dirty: false, mediaPlaying: true } }]);
  await w.scan();
  assert.equal(w.updates.length, 0);
});

test('restore does not overwrite a tab that has navigated elsewhere', async (t) => {
  const w = await worker(t, [ordinary(2)]);
  w.archive.set('old', { token: 'old', url: 'https://old.example/' });
  const result = await w.send('restore', { tabId: 2, token: 'old' });
  assert.equal(result.reason, 'tab-changed');
  assert.equal(w.updates.length, 0);
});

test('restore-all recovers token-only tabs after extension storage was lost, including duplicates', async (t) => {
  const url = buildLocalSleepPageUrl(DEFAULT_SETTINGS.sleepServerUrl, 'shared');
  const w = await worker(t, [ordinary(2, { url }), ordinary(3, { url })]);
  w.archive.set('shared', { token: 'shared', url: 'https://original.example/' });
  const result = await w.send('restore-all');
  assert.equal(result.restoredCount, 2);
  assert.deepEqual(w.updates.map((update) => update.id), [2, 3]);
});

test('sleep-page messages restore the sender tab instead of a supplied other tab', async (t) => {
  const url = buildLocalSleepPageUrl(DEFAULT_SETTINGS.sleepServerUrl, 'mine');
  const w = await worker(t, [ordinary(2, { url }), ordinary(3, { active: true })]);
  w.archive.set('mine', { token: 'mine', url: 'https://original.example/' });
  const result = await w.send('restore', { tabId: 3, token: 'mine' }, { tab: { id: 2 } });
  assert.equal(result.ok, true);
  assert.deepEqual(w.updates.map((update) => update.id), [2]);
});

test('parallel protection changes retain both sites', async (t) => {
  const w = await worker(t, [ordinary(2), ordinary(3)]);
  await Promise.all([2, 3].map((id) => w.send('set-allowlist-current', { currentTabId: id, currentUrl: w.tabs.get(id).url, enabled: true })));
  assert.deepEqual(w.store.settings.allowlist.sort(), ['example2.com', 'example3.com']);
});

test('bulk sleep never unloads a tab selected while the operation is queued', async (t) => {
  const w = await worker(t, [ordinary(2)], { profile: 'aggressive' });
  w.hooks.guard = async () => { w.tabs.get(2).active = true; };
  const result = await w.send('sleep-all-except-current');
  assert.equal(result.sleptCount, 0);
  assert.equal(w.updates.length, 0);
});

test('selected manually slept tab remains asleep during watchdog scans', async (t) => {
  const w = await worker(t, [ordinary(2, { active: true })]);
  const result = await w.send('sleep-current', { currentTabId: 2, currentUrl: w.tabs.get(2).url });
  assert.equal(result.ok, true);
  await w.scan();
  for (const fn of [...w.timers.values()]) await fn();
  await flush();
  assert.equal(w.updates.length, 1);
});
