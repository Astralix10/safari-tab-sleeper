import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    const response = await fetch(`http://127.0.0.1:${port}/memory`);
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
        headers: { 'content-type': 'application/json' },
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
      headers: { 'content-type': 'application/json' },
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
      headers: { 'content-type': 'application/json' },
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
    const response = await fetch(`http://127.0.0.1:${port}/power`);
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
      headers: { 'content-type': 'application/json' },
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

    const trustedOrigin = 'safari-web-extension://unit-test';
    const accepted = await fetch(`http://127.0.0.1:${port}/settings`, {
      method: 'POST',
      headers: { origin: trustedOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ allowlist: ['example.com'] }),
    });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.headers.get('access-control-allow-origin'), trustedOrigin);
  } finally {
    server.kill();
  }
});
