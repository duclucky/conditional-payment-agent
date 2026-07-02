import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireProcessLock } from '../src/wallet/process-lock.js';

async function tempLockPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cpa-process-lock-test-'));
  return join(dir, 'agent.lock');
}

test('no existing lock -> acquires immediately, recording our own pid', async () => {
  const lockPath = await tempLockPath();

  const lock = acquireProcessLock(lockPath, 'test');

  assert.ok(existsSync(lockPath));
  const written = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.equal(written.pid, process.pid);
  lock.release();
  assert.equal(existsSync(lockPath), false);
});

test('refuses to start if the recorded PID is alive', async () => {
  const lockPath = await tempLockPath();
  // Use OUR OWN pid — guaranteed alive for the duration of this test.
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now(), instanceId: 'other' }));

  assert.throws(() => acquireProcessLock(lockPath, 'test'), /already holding the wallet lock/);
  // The stale-but-alive lock must be left untouched, not clobbered.
  const stillThere = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.equal(stillThere.instanceId, 'other');
});

test('cleans up an orphaned lock (dead PID) and acquires successfully', async () => {
  const lockPath = await tempLockPath();

  // Spawn and synchronously wait for a real child process to exit — spawnSync only returns
  // once the child is dead, so its pid is guaranteed not to belong to a live process anymore.
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  const deadPid = child.pid;
  assert.ok(typeof deadPid === 'number' && deadPid > 0, 'spawnSync must report a pid');

  writeFileSync(lockPath, JSON.stringify({ pid: deadPid, startedAt: Date.now() - 999_999, instanceId: 'stale' }));

  const lock = acquireProcessLock(lockPath, 'test');

  const written = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.equal(written.pid, process.pid, 'the orphaned lock must be replaced with OUR pid, not left as the dead one');
  lock.release();
});

test('release() is idempotent — calling it twice does not throw', async () => {
  const lockPath = await tempLockPath();
  const lock = acquireProcessLock(lockPath, 'test');

  lock.release();
  assert.doesNotThrow(() => lock.release());
});
