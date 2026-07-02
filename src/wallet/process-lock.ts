import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from '../logger.js';

interface LockRecord {
  readonly pid: number;
  readonly startedAt: number;
  readonly instanceId: string;
}

export interface ProcessLock {
  readonly path: string;
  release(): void;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true; // process exists, just not signalable by us — still alive
    throw err;
  }
}

/**
 * Per-wallet exclusivity lock (PHASE3_PROCESS_DESIGN.md, Tầng 1). Verifies liveness by asking
 * the OS directly (process.kill(pid, 0)) — never the harness/supervisor that started the prior
 * process. This is what makes it correct even when an external "stop" command lies about having
 * actually killed the process (SPLIT_REPORT.md §5: a stop call killed only the outer wrapper in
 * a multi-level process tree, leaving the real node process — and its lock — alive for over ten
 * minutes before anyone noticed).
 */
export function acquireProcessLock(lockPath: string, scope: string): ProcessLock {
  if (existsSync(lockPath)) {
    const recorded = JSON.parse(readFileSync(lockPath, 'utf8')) as LockRecord;
    if (isPidAlive(recorded.pid)) {
      throw new Error(
        `Another process (PID ${recorded.pid}, started ${new Date(recorded.startedAt).toISOString()}, ` +
          `instance ${recorded.instanceId}) is already holding the wallet lock at ${lockPath}.\n` +
          `Refusing to start — running two processes against the same wallet WILL corrupt state ` +
          `(see SPLIT_REPORT.md §5).\n` +
          `If you have verified PID ${recorded.pid} is NOT actually related to this wallet (e.g. a ` +
          `reused PID), delete ${lockPath} manually and retry.`,
      );
    }
    log.warn(scope, `found orphaned lock from dead PID ${recorded.pid} (started ${new Date(recorded.startedAt).toISOString()}) — cleaning up`);
  }

  const record: LockRecord = { pid: process.pid, startedAt: Date.now(), instanceId: randomBytes(4).toString('hex') };
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify(record, null, 2), 'utf8');
  log.info(scope, `process lock acquired: PID ${record.pid}, instance ${record.instanceId}`);

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.removeListener('exit', release);
    try {
      unlinkSync(lockPath);
    } catch {
      // already gone — fine
    }
  };
  // Safety net for the normal-exit paths (explicit process.exit(), natural event-loop drain,
  // uncaught exception). Does NOT run on SIGKILL/-Force — that's exactly the orphaned-lock case
  // the startup check above exists to recover from.
  process.on('exit', release);

  return { path: lockPath, release };
}
