import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { getLogHistory, log, onLogEntry, type LogEntry } from '../logger.js';
import type { RuleEngine } from '../rules/engine.js';
import { cooldownRemainingSeconds } from '../rules/guards.js';
import type { Rule } from '../rules/types.js';
import { DASHBOARD_HTML } from './dashboard-page.js';

const SCOPE = 'dashboard';
const SSE_HEARTBEAT_MS = 20_000;

export interface DashboardIdentity {
  readonly nametag: string | undefined;
  readonly directAddress: string | undefined;
  readonly chainPubkey: string | undefined;
}

export interface DashboardServerOptions {
  readonly port: number;
  readonly host: string;
  readonly engine: RuleEngine;
  /** Passed as a narrow, explicit struct (not the wallet/sphere handle) so there is no path by
   * which a careless future change could serialize the mnemonic or oracle API key into a
   * response — this module never receives them in the first place. */
  readonly identity: DashboardIdentity;
  readonly network: string;
}

export interface DashboardServerHandle {
  readonly url: string;
  close(): Promise<void>;
}

interface RuleView {
  readonly id: string;
  readonly enabled: boolean;
  readonly trigger: Rule['trigger'];
  readonly action: Rule['action'];
  readonly guards: Rule['guards'];
  readonly fireCount: number;
  readonly lastFiredAt: number | undefined;
  readonly cooldownRemainingSeconds: number;
}

function toRuleView(rule: Rule, now: number): RuleView {
  return {
    id: rule.id,
    enabled: rule.enabled,
    trigger: rule.trigger,
    action: rule.action,
    guards: rule.guards,
    fireCount: rule.state.fireCount,
    lastFiredAt: rule.state.lastFiredAt,
    cooldownRemainingSeconds: cooldownRemainingSeconds(rule, now),
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

function writeSseEntry(res: ServerResponse, entry: LogEntry): void {
  res.write(`id: ${entry.seq}\ndata: ${JSON.stringify(entry)}\n\n`);
}

async function handleRules(req: IncomingMessage, res: ServerResponse, url: URL, opts: DashboardServerOptions): Promise<boolean> {
  const method = req.method ?? 'GET';
  const match = /^\/api\/rules\/([^/]+)\/toggle$/.exec(url.pathname);
  if (!(method === 'POST' && match)) return false;

  const id = decodeURIComponent(match[1] ?? '');
  const rule = opts.engine.rules.get(id);
  if (!rule) {
    sendJson(res, 404, { error: `rule not found: ${id}` });
    return true;
  }

  const body = (await readJsonBody(req)) as { enabled?: unknown };
  if (typeof body.enabled !== 'boolean') {
    sendJson(res, 400, { error: 'body must be {"enabled": boolean}' });
    return true;
  }

  // Mutates the SAME in-memory RuleStore instance the agent's own event loop already holds and
  // persists through — this is the entire reason the dashboard server lives inside the agent
  // process instead of being a standalone process that writes rules.json directly. A second
  // writer's edit would survive only until the agent's next RuleStore.saveState() call (e.g.
  // after any rule fires), which stamps its stale in-memory copy back over the file — exactly
  // the incident in SPLIT_REPORT.md §5. Going through `opts.engine.rules` avoids that entirely.
  await opts.engine.rules.setEnabled(id, body.enabled);
  log.info(SCOPE, `rule ${id} ${body.enabled ? 'enabled' : 'disabled'} via dashboard`);
  sendJson(res, 200, { rule: toRuleView(opts.engine.rules.get(id)!, Date.now()) });
  return true;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, opts: DashboardServerOptions): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const method = req.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(DASHBOARD_HTML);
    return;
  }

  if (method === 'GET' && url.pathname === '/api/status') {
    const now = Date.now();
    sendJson(res, 200, {
      now,
      network: opts.network,
      identity: opts.identity,
      rules: opts.engine.rules.list().map((r) => toRuleView(r, now)),
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/log') {
    const since = Number(url.searchParams.get('since') ?? '0') || 0;
    sendJson(res, 200, { entries: getLogHistory(since) });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/log/stream') {
    const since = Number(url.searchParams.get('since') ?? '0') || 0;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    for (const entry of getLogHistory(since)) writeSseEntry(res, entry);

    const unsubscribe = onLogEntry((entry) => writeSseEntry(res, entry));
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), SSE_HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return;
  }

  if (await handleRules(req, res, url, opts)) return;

  sendJson(res, 404, { error: 'not found' });
}

/**
 * Read-only observation window + rule on/off switch, served from INSIDE the agent process
 * (CLAUDE.md 4.1 / PHASE3_PROCESS_DESIGN.md: one wallet, one process). It never opens its own
 * Sphere instance and never receives the mnemonic or oracle API key — only a narrow identity
 * struct and the already-loaded RuleEngine are passed in.
 */
export function startDashboardServer(opts: DashboardServerOptions): DashboardServerHandle {
  const server = createServer((req, res) => {
    handleRequest(req, res, opts).catch((err) => {
      log.error(SCOPE, `request handler threw for ${req.method ?? '?'} ${req.url ?? '?'}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    });
  });

  server.listen(opts.port, opts.host);

  return {
    url: `http://${opts.host}:${opts.port}`,
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
