type Level = 'info' | 'warn' | 'error';

export interface LogEntry {
  readonly seq: number;
  readonly ts: number;
  readonly level: Level;
  readonly scope: string;
  readonly message: string;
}

type LogListener = (entry: LogEntry) => void;

// Dashboard (Phase 4) needs the same activity stream a human watching the console already sees,
// without touching every call site in engine.ts/executor.ts/guards.ts/scheduler.ts. Hooking the
// logger itself — the one choke point every scope already calls through — gets full coverage for
// free and can't drift from what actually gets logged.
const RING_CAPACITY = 500;
const ring: LogEntry[] = [];
let seqCounter = 0;
const listeners = new Set<LogListener>();

function line(level: Level, scope: string, message: string): void {
  const tag = `[${new Date().toISOString()}] [${scope}] ${message}`;
  if (level === 'error') console.error(tag);
  else if (level === 'warn') console.warn(tag);
  else console.log(tag);

  const entry: LogEntry = { seq: ++seqCounter, ts: Date.now(), level, scope, message };
  ring.push(entry);
  if (ring.length > RING_CAPACITY) ring.shift();
  for (const listener of listeners) listener(entry);
}

export const log = {
  info: (scope: string, message: string): void => line('info', scope, message),
  warn: (scope: string, message: string): void => line('warn', scope, message),
  error: (scope: string, message: string): void => line('error', scope, message),
};

/** Entries with seq > sinceSeq, oldest first. sinceSeq=0 (default) returns the whole ring. */
export function getLogHistory(sinceSeq = 0): LogEntry[] {
  return ring.filter((e) => e.seq > sinceSeq);
}

/** Subscribe to new entries as they're logged. Returns an unsubscribe function. */
export function onLogEntry(listener: LogListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
