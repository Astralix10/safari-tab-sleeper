import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('memory guard parses aggregate and max process RSS from ps-like input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'safari-tab-sleeper-'));
  const sample = join(dir, 'ps.txt');
  await writeFile(sample, [
    '101 1500000 /Applications/Safari.app/Contents/MacOS/Safari',
    '102 4200000 /System/Library/Frameworks/WebKit.framework/com.apple.WebKit.WebContent',
    '103 900000 /usr/libexec/OtherProcess',
    '104 6400000 /System/Library/Frameworks/WebKit.framework/com.apple.WebKit.WebContent',
  ].join('\n'));

  const { stdout } = await execFileAsync('zsh', [
    'companion/memory-guard.zsh',
    '--sample',
    sample,
    '--threshold-gb',
    '5',
    '--once',
    '--dry-run',
  ], {
    cwd: new URL('..', import.meta.url),
  });

  assert.match(stdout, /total_mb=11816/);
  assert.match(stdout, /max_mb=6250/);
  assert.match(stdout, /over_threshold=1/);
});

test('memory guard default threshold is 3 GB', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'safari-tab-sleeper-'));
  const sample = join(dir, 'ps.txt');
  const swapSample = join(dir, 'swap.txt');
  await writeFile(sample, [
    '101 1500000 /Applications/Safari.app/Contents/MacOS/Safari',
    '102 1800000 /System/Library/Frameworks/WebKit.framework/com.apple.WebKit.WebContent',
  ].join('\n'));
  await writeFile(swapSample, 'vm.swapusage: total = 8192.00M  used = 0.00M  free = 8192.00M  (encrypted)\n');

  const { stdout } = await execFileAsync('zsh', [
    'companion/memory-guard.zsh',
    '--sample',
    sample,
    '--swap-sample',
    swapSample,
    '--once',
    '--dry-run',
  ], {
    cwd: new URL('..', import.meta.url),
  });

  assert.match(stdout, /total_mb=3223/);
  assert.match(stdout, /swap_used_mb=0/);
  assert.match(stdout, /over_threshold=1/);
});

test('memory guard shows user alerts only after 5 GB by default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'safari-tab-sleeper-'));
  const sample4gb = join(dir, 'ps-4gb.txt');
  const sample6gb = join(dir, 'ps-6gb.txt');
  const swapSample = join(dir, 'swap.txt');
  await writeFile(sample4gb, '101 4194304 /Applications/Safari.app/Contents/MacOS/Safari\n');
  await writeFile(sample6gb, '101 6291456 /Applications/Safari.app/Contents/MacOS/Safari\n');
  await writeFile(swapSample, 'vm.swapusage: total = 8192.00M  used = 0.00M  free = 8192.00M  (encrypted)\n');

  const low = await execFileAsync('zsh', [
    'companion/memory-guard.zsh',
    '--sample',
    sample4gb,
    '--swap-sample',
    swapSample,
    '--once',
    '--dry-run',
  ], {
    cwd: new URL('..', import.meta.url),
  });

  const high = await execFileAsync('zsh', [
    'companion/memory-guard.zsh',
    '--sample',
    sample6gb,
    '--swap-sample',
    swapSample,
    '--once',
    '--dry-run',
  ], {
    cwd: new URL('..', import.meta.url),
  });

  assert.match(low.stdout, /over_threshold=1/);
  assert.match(low.stdout, /over_alert=0/);
  assert.match(high.stdout, /over_threshold=1/);
  assert.match(high.stdout, /over_alert=1/);
});

test('memory guard treats swap pressure as over threshold even when Safari RSS is low', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'safari-tab-sleeper-'));
  const psSample = join(dir, 'ps.txt');
  const swapSample = join(dir, 'swap.txt');
  await writeFile(psSample, [
    '101 200000 /Applications/Safari.app/Contents/MacOS/Safari',
    '102 300000 /System/Library/Frameworks/WebKit.framework/com.apple.WebKit.WebContent',
  ].join('\n'));
  await writeFile(swapSample, 'vm.swapusage: total = 8192.00M  used = 4096.00M  free = 4096.00M  (encrypted)\n');

  const { stdout } = await execFileAsync('zsh', [
    'companion/memory-guard.zsh',
    '--sample',
    psSample,
    '--swap-sample',
    swapSample,
    '--once',
    '--dry-run',
  ], {
    cwd: new URL('..', import.meta.url),
  });

  assert.match(stdout, /total_mb=488/);
  assert.match(stdout, /swap_used_mb=4096/);
  assert.match(stdout, /over_threshold=1/);
});

test('memory guard uses notification center instead of modal dialogs', async () => {
  const script = await readFile(new URL('../companion/memory-guard.zsh', import.meta.url), 'utf8');

  assert.equal(script.includes('display dialog'), false);
  assert.equal(script.includes('display notification'), true);
});

test('memory guard waits for extension settings sync before pressure sleeping', async () => {
  const script = await readFile(new URL('../companion/memory-guard.zsh', import.meta.url), 'utf8');

  assert.equal(script.includes('settings-ready'), true);
  assert.equal(script.includes('settings_are_synced()'), true);
  assert.equal(script.includes('settings_pending=1'), true);
});
