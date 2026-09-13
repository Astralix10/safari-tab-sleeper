import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';

const MUTATION_TOKEN = 'test-token-do-not-use';
process.env.SAFARI_TAB_SLEEPER_MUTATION_TOKEN = MUTATION_TOKEN;
const mutationHeaders = (extra = {}) => ({
  'content-type': 'application/json',
  'x-safari-tab-sleeper-token': MUTATION_TOKEN,
  'x-safari-tab-sleeper-native': '1',
  ...extra,
});

test('live recovery tokens survive duplicate compaction, archive limits and restart', async () => {
  const port = 28000 + Math.floor(Math.random() * 500);
  const dir = await mkdtemp(join(tmpdir(), 'sleeper-live-archive-'));
  const env = {
    ...process.env,
    SAFARI_TAB_SLEEPER_PORT: String(port),
    SAFARI_TAB_SLEEPER_ARCHIVE_LIMIT: '1',
    SAFARI_TAB_SLEEPER_ARCHIVE_PATH: join(dir, 'archive.json'),
    SAFARI_TAB_SLEEPER_ALLOWLIST_PATH: join(dir, 'allowlist.txt'),
  };
  const start = () => spawn('python3', ['companion/sleeper-server.py'], { cwd: new URL('..', import.meta.url), env, stdio: 'ignore' });
  let server = start();
  const tokens = ['first', 'duplicate', 'third'];
  const post = async (body) => fetch(`http://127.0.0.1:${port}/archive-entry`, { method: 'POST', headers: mutationHeaders(), body: JSON.stringify(body) });
  try {
    await waitForHealth(port);
    for (let i = 0; i < tokens.length; i++) {
      const response = await post({ activeTokens: tokens.slice(0, i + 1), entry: {
        token: tokens[i], url: i < 2 ? 'https://same.example/' : 'https://third.example/', sleptAt: 1000 + i,
      } });
      assert.equal(response.status, 200);
    }
    const exited = once(server, 'exit'); server.kill(); await exited;
    server = start(); await waitForHealth(port);
    for (const token of tokens) {
      assert.equal((await fetch(`http://127.0.0.1:${port}/archive-entry?token=${token}`)).status, 200);
    }
    assert.equal((await post({ action: 'reconcile', activeTokens: [] })).status, 200);
    const archived = JSON.parse(await readFile(join(dir, 'archive.json'), 'utf8'));
    assert.equal(archived.entries.length, 1);
    assert.equal(archived.entries[0].token, 'third');
    assert.deepEqual(archived.activeTokens, []);
  } finally {
    const exited = once(server, 'exit'); server.kill(); await exited;
  }
});

test('local sleep page only restores web URLs or supported Reader wrappers', async () => {
  const source = await readFile(new URL('../companion/sleeper-server.py', import.meta.url), 'utf8');
  const script = source.match(/<script>([\s\S]*?)<\/script>/)[1];
  const element = { addEventListener() {} };
  const context = {
    URL, URLSearchParams, TextDecoder, Uint8Array, atob,
    location: { hash: '', search: '' },
    document: { querySelector: () => ({ ...element }), visibilityState: 'hidden' },
    window: { addEventListener() {} },
  };
  runInNewContext(script + '\nthis.normalize = normalizeRestorableUrl;', context);
  assert.equal(context.normalize("javascript:location='https://evil.example/'"), '');
  assert.equal(context.normalize('https://example.com/a%2Fb?q=one%26two'), 'https://example.com/a%2Fb?q=one%26two');
  assert.equal(context.normalize('about:reader?url=https%3A%2F%2Fexample.com%2Fstory'), 'https://example.com/story');
  assert.equal(context.normalize('http://127.0.0.1:17654/sleep#token=missing'), '');
});

function requestStatus({ port, path = '/', headers = {} }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path, headers }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
}

async function waitForHealth(port) {
  const url = `http://127.0.0.1:${port}/health`;
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }

  throw new Error('sleep server did not start');
}

test('sleep server exposes current Safari memory status as JSON', async () => {
  const port = 22000 + Math.floor(Math.random() * 1000);
  const server = spawn('python3', ['companion/sleeper-server.py'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      SAFARI_TAB_SLEEPER_PORT: String(port),
    },
    stdio: 'ignore',
  });

  try {
    await waitForHealth(port);
    const response = await fetch(`http://127.0.0.1:${port}/memory`, { headers: mutationHeaders() });
    assert.equal(response.ok, true);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);

    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(Number.isFinite(body.totalMb), true);
    assert.equal(Number.isFinite(body.maxMb), true);
    assert.equal(Number.isFinite(body.swapUsedMb), true);
    assert.equal(typeof body.label, 'string');
    assert.match(body.label, /Safari\/WebKit/);
  } finally {
    server.kill();
  }
});

test('sleep server reports a recent authenticated extension heartbeat', async () => {
  const port = 22200 + Math.floor(Math.random() * 200);
  const dir = await mkdtemp(join(tmpdir(), 'safari-tab-sleeper-heartbeat-'));
  const heartbeatPath = join(dir, 'extension-heartbeat.txt');
  const server = spawn('python3', ['companion/sleeper-server.py'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      SAFARI_TAB_SLEEPER_PORT: String(port),
      SAFARI_TAB_SLEEPER_HEARTBEAT_PATH: heartbeatPath,
    },
    stdio: 'ignore',
  });

  try {
    await waitForHealth(port);
    const initial = await fetch(`http://127.0.0.1:${port}/extension-state`).then((response) => response.json());
    assert.equal(initial.ok, true);
    assert.equal(initial.active, false);

    const heartbeat = await fetch(`http://127.0.0.1:${port}/heartbeat`, {
      method: 'POST',
      headers: mutationHeaders(),
      body: '{}',
    });
    assert.equal(heartbeat.ok, true);

    const current = await fetch(`http://127.0.0.1:${port}/extension-state`).then((response) => response.json());
    assert.equal(current.ok, true);
    assert.equal(current.active, true);
    assert.equal(typeof current.ageSeconds, 'number');
    assert.equal(Number.isFinite(Number((await readFile(heartbeatPath, 'utf8')).trim())), true);
  } finally {
    server.kill();
  }
});

test('sleep server page accepts legacy AppleScript restore hashes', async () => {
  const port = 22500 + Math.floor(Math.random() * 400);
  const server = spawn('python3', ['companion/sleeper-server.py'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, SAFARI_TAB_SLEEPER_PORT: String(port) },
    stdio: 'ignore',
  });

  try {
    await waitForHealth(port);
    const response = await fetch(`http://127.0.0.1:${port}/sleep`);
    const html = await response.text();
    assert.equal(response.ok, true);
    assert.equal(html.includes('function legacySleepEntry'), true);
    assert.equal(html.includes("hashParams.get('url')"), true);
  } finally {
    server.kill();
  }
});

test('sleep server archives sleep entries and removes duplicate URLs', async () => {
  const port = 23000 + Math.floor(Math.random() * 1000);
  const dir = await mkdtemp(join(tmpdir(), 'safari-tab-sleeper-archive-'));
  const server = spawn('python3', ['companion/sleeper-server.py'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      SAFARI_TAB_SLEEPER_PORT: String(port),
      SAFARI_TAB_SLEEPER_ARCHIVE_PATH: join(dir, 'archive.json'),
    },
    stdio: 'ignore',
  });

  try {
    await waitForHealth(port);
    const first = {
      token: 'first-token',
      url: 'https://example.com/report',
      title: 'Old report',
      sleptAt: 1_000,
      reason: 'inactive-timeout',
      autoRestore: true,
    };
    const second = {
      ...first,
      token: 'second-token',
      title: 'New report',
      sleptAt: 2_000,
    };

    for (const entry of [first, second]) {
      const response = await fetch(`http://127.0.0.1:${port}/archive-entry`, {
        method: 'POST',
        headers: mutationHeaders(),
        body: JSON.stringify({ entry }),
      });
      assert.equal(response.ok, true);
    }

    const stale = await fetch(`http://127.0.0.1:${port}/archive-entry?token=first-token`);
    assert.equal(stale.status, 404);

    const latest = await fetch(`http://127.0.0.1:${port}/archive-entry?token=second-token`);
    assert.equal(latest.ok, true);
    const body = await latest.json();
    assert.equal(body.ok, true);
    assert.equal(body.entry.title, 'New report');
    assert.equal(body.count, 1);
  } finally {
    server.kill();
  }
});

test('sleep server unwraps nested sleep URLs before archiving', async () => {
  const port = 23500 + Math.floor(Math.random() * 400);
  const dir = await mkdtemp(join(tmpdir(), 'safari-tab-sleeper-nested-'));
  const server = spawn('python3', ['companion/sleeper-server.py'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      SAFARI_TAB_SLEEPER_PORT: String(port),
      SAFARI_TAB_SLEEPER_ARCHIVE_PATH: join(dir, 'archive.json'),
    },
    stdio: 'ignore',
  });

  const originalUrl = 'https://example.com/original';
  const fallback = Buffer.from(JSON.stringify({ url: originalUrl }), 'utf8').toString('base64url');
  const nestedUrl = `http://127.0.0.1:17654/sleep#fallback=${fallback}`;

  try {
    await waitForHealth(port);
    const stored = await fetch(`http://127.0.0.1:${port}/archive-entry`, {
      method: 'POST',
      headers: mutationHeaders(),
      body: JSON.stringify({
        entry: { token: 'nested-token', url: nestedUrl, title: 'Nested', sleptAt: 1 },
      }),
    });
    assert.equal(stored.ok, true);

    const response = await fetch(`http://127.0.0.1:${port}/archive-entry?token=nested-token`);
    const body = await response.json();
    assert.equal(body.entry.url, originalUrl);
  } finally {
    server.kill();
  }
});

test('sleep server keeps every unique entry during concurrent archive writes', async () => {
  const port = 23800 + Math.floor(Math.random() * 150);
  const dir = await mkdtemp(join(tmpdir(), 'safari-tab-sleeper-concurrent-'));
  const archivePath = join(dir, 'archive.json');
  const server = spawn('python3', ['companion/sleeper-server.py'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      SAFARI_TAB_SLEEPER_PORT: String(port),
      SAFARI_TAB_SLEEPER_ARCHIVE_PATH: archivePath,
    },
    stdio: 'ignore',
  });

  try {
    await waitForHealth(port);
    const entries = Array.from({ length: 12 }, (_, index) => ({
      token: `concurrent-${index}`,
      url: `https://example.com/report/${index}`,
      title: `Report ${index}`,
      sleptAt: 10_000 + index,
      reason: 'inactive-timeout',
    }));
    const responses = await Promise.all(entries.map((entry) => fetch(`http://127.0.0.1:${port}/archive-entry`, {
      method: 'POST',
      headers: mutationHeaders(),
      body: JSON.stringify({ entry }),
    })));

    assert.equal(responses.every((response) => response.ok), true);
    const archive = JSON.parse(await readFile(archivePath, 'utf8'));
    assert.equal(archive.entries.length, entries.length);
    assert.deepEqual(
      new Set(archive.entries.map((entry) => entry.token)),
      new Set(entries.map((entry) => entry.token)),
    );
  } finally {
    server.kill();
  }
});

test('sleep server exposes power source status', async () => {
  const port = 24000 + Math.floor(Math.random() * 1000);
  const server = spawn('python3', ['companion/sleeper-server.py'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      SAFARI_TAB_SLEEPER_PORT: String(port),
    },
    stdio: 'ignore',
  });

  try {
    await waitForHealth(port);
    const response = await fetch(`http://127.0.0.1:${port}/power`, { headers: mutationHeaders() });
    assert.equal(response.ok, true);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.match(body.source, /^(battery|power|unknown)$/);
    assert.equal(typeof body.label, 'string');
  } finally {
    server.kill();
  }
});

test('sleep server syncs extension allowlist for companion AppleScript cleanup', async () => {
  const port = 25000 + Math.floor(Math.random() * 1000);
  const dir = await mkdtemp(join(tmpdir(), 'safari-tab-sleeper-settings-'));
  const allowlistPath = join(dir, 'allowlist.txt');
  const settingsReadyPath = join(dir, 'settings-ready');
  const server = spawn('python3', ['companion/sleeper-server.py'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      SAFARI_TAB_SLEEPER_PORT: String(port),
      SAFARI_TAB_SLEEPER_ALLOWLIST_PATH: allowlistPath,
      SAFARI_TAB_SLEEPER_SETTINGS_READY_PATH: settingsReadyPath,
    },
    stdio: 'ignore',
  });

  try {
    await waitForHealth(port);
    const response = await fetch(`http://127.0.0.1:${port}/settings`, {
      method: 'POST',
      headers: mutationHeaders(),
      body: JSON.stringify({
        allowlist: ['www.youtube.com', '*.example.com', '#ignored'],
      }),
    });
    assert.equal(response.ok, true);

    const body = await response.json();
    assert.equal(body.ready, true);
    assert.deepEqual(body.allowlist, [
      'www.youtube.com',
      'youtube.com',
      '*.youtube.com',
      'youtu.be',
      '*.youtu.be',
      'youtube-nocookie.com',
      '*.youtube-nocookie.com',
      '*.example.com',
    ]);
    assert.equal(
      await readFile(allowlistPath, 'utf8'),
      [
        'www.youtube.com',
        'youtube.com',
        '*.youtube.com',
        'youtu.be',
        '*.youtu.be',
        'youtube-nocookie.com',
        '*.youtube-nocookie.com',
        '*.example.com',
        '',
      ].join('\n'),
    );
    assert.equal(await readFile(settingsReadyPath, 'utf8'), 'ready\n');
  } finally {
    server.kill();
  }
});

test('sleep server rejects settings writes from ordinary web pages', async () => {
  const port = 26000 + Math.floor(Math.random() * 400);
  const dir = await mkdtemp(join(tmpdir(), 'safari-tab-sleeper-cors-'));
  const server = spawn('python3', ['companion/sleeper-server.py'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      SAFARI_TAB_SLEEPER_PORT: String(port),
      SAFARI_TAB_SLEEPER_ALLOWLIST_PATH: join(dir, 'allowlist.txt'),
      SAFARI_TAB_SLEEPER_SETTINGS_READY_PATH: join(dir, 'settings-ready'),
      SAFARI_TAB_SLEEPER_TRUSTED_ORIGIN_PATH: join(dir, 'trusted-origin.txt'),
    },
    stdio: 'ignore',
  });

  try {
    await waitForHealth(port);
    const rejected = await fetch(`http://127.0.0.1:${port}/settings`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
      body: JSON.stringify({ allowlist: [] }),
    });
    assert.equal(rejected.status, 403);

    const websiteWithClientHeaders = await fetch(`http://127.0.0.1:${port}/memory`, {
      headers: mutationHeaders({ origin: 'https://evil.example' }),
    });
    assert.equal(websiteWithClientHeaders.status, 403);

    const trustedOrigin = 'safari-web-extension://unit-test';
    const missingToken = await fetch(`http://127.0.0.1:${port}/settings`, {
      method: 'POST',
      headers: { origin: trustedOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ allowlist: ['evil.example'] }),
    });
    assert.equal(missingToken.status, 403);

    const accepted = await fetch(`http://127.0.0.1:${port}/settings`, {
      method: 'POST',
      headers: mutationHeaders({ origin: trustedOrigin }),
      body: JSON.stringify({ allowlist: ['example.com'] }),
    });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.headers.get('access-control-allow-origin'), trustedOrigin);

    const rotatedOrigin = 'safari-web-extension://rotated-after-update';
    const rotated = await fetch(`http://127.0.0.1:${port}/settings`, {
      method: 'POST',
      headers: mutationHeaders({ origin: rotatedOrigin }),
      body: JSON.stringify({ allowlist: ['rotated.example'] }),
    });
    assert.equal(rotated.ok, true);
    assert.equal(rotated.headers.get('access-control-allow-origin'), rotatedOrigin);
    assert.equal(await readFile(join(dir, 'trusted-origin.txt'), 'utf8'), `${rotatedOrigin}\n`);
  } finally {
    server.kill();
  }
});

test('sleep server reports malformed mutation JSON as a client error', async () => {
  const port = 26500 + Math.floor(Math.random() * 300);
  const server = spawn('python3', ['companion/sleeper-server.py'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, SAFARI_TAB_SLEEPER_PORT: String(port) },
    stdio: 'ignore',
  });

  try {
    await waitForHealth(port);
    const response = await fetch(`http://127.0.0.1:${port}/settings`, {
      method: 'POST',
      headers: mutationHeaders(),
      body: '{broken',
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, reason: 'invalid-json' });
  } finally {
    server.kill();
  }
});

test('sleep-current endpoint requires the extension protection checks', async () => {
  const port = 26900 + Math.floor(Math.random() * 90);
  const dir = await mkdtemp(join(tmpdir(), 'safari-tab-sleeper-current-'));
  const scriptPath = join(dir, 'sleep-current.applescript');
  await writeFile(scriptPath, 'on run argv\nreturn "slept_count=1"\nend run\n');
  const server = spawn('python3', ['companion/sleeper-server.py'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      SAFARI_TAB_SLEEPER_PORT: String(port),
      SAFARI_TAB_SLEEPER_CURRENT_SCRIPT: scriptPath,
      SAFARI_TAB_SLEEPER_ALLOWLIST_PATH: join(dir, 'allowlist.txt'),
      SAFARI_TAB_SLEEPER_ARCHIVE_PATH: join(dir, 'archive.json'),
    },
    stdio: 'ignore',
  });

  try {
    await waitForHealth(port);
    const response = await fetch(`http://127.0.0.1:${port}/sleep-current`, {
      method: 'POST',
      headers: mutationHeaders(),
      body: '{}',
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.reason, 'extension-required');
  } finally {
    server.kill();
  }
});

test('sleep server validates Host, protects sensitive reads, and rejects empty settings', async () => {
  const port = 27000 + Math.floor(Math.random() * 300);
  const dir = await mkdtemp(join(tmpdir(), 'safari-tab-sleeper-security-'));
  const server = spawn('python3', ['companion/sleeper-server.py'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      SAFARI_TAB_SLEEPER_PORT: String(port),
      SAFARI_TAB_SLEEPER_ALLOWLIST_PATH: join(dir, 'allowlist.txt'),
      SAFARI_TAB_SLEEPER_SETTINGS_PATH: join(dir, 'settings.json'),
      SAFARI_TAB_SLEEPER_SETTINGS_READY_PATH: join(dir, 'settings-ready'),
    },
    stdio: 'ignore',
  });

  try {
    await waitForHealth(port);
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/memory`)).status, 403);
    assert.equal(await requestStatus({
      port,
      path: '/memory',
      headers: mutationHeaders({ host: `attacker.example:${port}` }),
    }), 421);

    const saved = await fetch(`${base}/settings`, {
      method: 'POST',
      headers: mutationHeaders(),
      body: JSON.stringify({ allowlist: ['protected.example'], pressureDomains: ['video.example'] }),
    });
    assert.equal(saved.ok, true);

    const rejected = await fetch(`${base}/settings`, {
      method: 'POST',
      headers: mutationHeaders(),
      body: '{}',
    });
    assert.equal(rejected.status, 400);

    const current = await fetch(`${base}/settings`, { headers: mutationHeaders() }).then((response) => response.json());
    assert.deepEqual(current.allowlist, ['protected.example']);
    assert.deepEqual(current.pressureDomains, ['video.example']);

    const queued = await fetch(`${base}/cleanup-request`, {
      method: 'POST',
      headers: mutationHeaders(),
      body: JSON.stringify({ action: 'queue', totalMb: 4096, maxMb: 3500 }),
    }).then((response) => response.json());
    assert.equal(queued.queued, true);
    const pending = await fetch(`${base}/cleanup-request`, { headers: mutationHeaders() }).then((response) => response.json());
    assert.equal(pending.pending, true);
    assert.equal(pending.requestId, queued.requestId);
  } finally {
    server.kill();
  }
});
