import type { IncomingTransfer, TransferResult } from '@unicitylabs/sphere-sdk';
import { loadConfig, nametagPrefixForRole } from '../src/config.js';
import { log } from '../src/logger.js';
import { RuleEngine } from '../src/rules/engine.js';
import { IdentityResolver } from '../src/rules/identity-cache.js';
import { Scheduler } from '../src/rules/scheduler.js';
import { initWallet } from '../src/wallet/init.js';
import { startDashboardServer } from '../src/server/dashboard-server.js';

const SCOPE = 'agent';

/** Phase 3/4 entry point: agent wallet + live Rule Matcher -> Guard Check -> Action Executor,
 * Event Listener + Scheduler + read-only Dashboard, in one always-on process. */
async function main(): Promise<void> {
  const config = loadConfig();
  const wallet = await initWallet({ name: 'agent', nametagPrefix: nametagPrefixForRole('agent') }, config);
  const { sphere } = wallet;

  log.info(SCOPE, `directAddress = ${sphere.identity?.directAddress}`);
  log.info(SCOPE, `nametag       = ${wallet.nametag ? '@' + wallet.nametag : '(none registered)'}`);
  log.info(SCOPE, `chainPubkey   = ${sphere.identity?.chainPubkey}`);

  const resolver = new IdentityResolver(sphere);
  const engine = await RuleEngine.load(sphere, resolver);
  log.info(SCOPE, `loaded ${engine.rules.list().length} rule(s) from store/rules.json`);
  for (const rule of engine.rules.list()) {
    log.info(SCOPE, `  rule ${rule.id} [${rule.enabled ? 'enabled' : 'disabled'}] ${rule.trigger.type} -> ${rule.action.type}`);
  }

  sphere.on('transfer:incoming', (transfer: IncomingTransfer) => {
    log.info(SCOPE, `transfer:incoming id=${transfer.id} senderPubkey=${transfer.senderPubkey} memo=${JSON.stringify(transfer.memo ?? null)}`);
    engine.handleIncomingTransfer(transfer).catch((err) => {
      log.error(SCOPE, `handleIncomingTransfer threw for ${transfer.id}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    });
  });

  sphere.on('transfer:failed', (result: TransferResult) => {
    log.error(SCOPE, `transfer:failed id=${result.id} error=${result.error ?? '(no error message)'}`);
  });

  const tickMs = Number(process.env.SCHEDULER_TICK_MS) || undefined;
  const scheduler = new Scheduler(engine, tickMs);
  scheduler.start();

  // Runs INSIDE this process, on the same in-memory RuleStore — never a second process writing
  // rules.json (see dashboard-server.ts header comment / SPLIT_REPORT.md §5).
  const dashboard = startDashboardServer({
    port: config.dashboardPort,
    host: config.dashboardHost,
    engine,
    network: config.network,
    identity: { nametag: wallet.nametag, directAddress: sphere.identity?.directAddress, chainPubkey: sphere.identity?.chainPubkey },
  });
  log.info(SCOPE, `dashboard listening at ${dashboard.url}`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(SCOPE, `received ${signal} — shutting down gracefully`);
    scheduler.stop();
    dashboard
      .close()
      .catch((err) => log.error(SCOPE, `dashboard server close failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        wallet.release();
        process.exit(0);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  log.info(SCOPE, 'agent running — Ctrl+C to stop');
  await new Promise<never>(() => {
    // Keep the process alive for the delivery port's background poll/wake and the Scheduler.
  });
}

main().catch((err) => {
  log.error(SCOPE, `fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exitCode = 1;
});
