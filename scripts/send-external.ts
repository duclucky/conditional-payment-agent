import { TokenRegistry, getCoinIdBySymbol, getTokenDecimals, getTokenSymbol, parseTokenAmount, isSphereError } from '@unicitylabs/sphere-sdk';
import { loadConfig, nametagPrefixForRole } from '../src/config.js';
import { initWallet } from '../src/wallet/init.js';
import { log } from '../src/logger.js';

const SCOPE = 'send-external';

/**
 * Phase 1 step 5 — agent wallet sends to an EXTERNAL nametag. TODO (user-provided): this
 * nametag is not ours to guess. Pass it as an argument or set EXTERNAL_TEST_NAMETAG in .env.
 */
function parseArgs(): { to: string; amount: string; memo?: string } {
  const [toArg, amountArg, memoArg] = process.argv.slice(2);
  const to = toArg ?? process.env.EXTERNAL_TEST_NAMETAG;
  if (!to || !amountArg) {
    throw new Error(
      'Usage: tsx scripts/send-external.ts <toNametag> <amount> [memo]\n' +
        'Or set EXTERNAL_TEST_NAMETAG in .env and omit <toNametag>.\n' +
        'TODO: this nametag must be supplied by the user (see PHASE1_REPORT.md) — not guessed.',
    );
  }
  return { to, amount: amountArg, memo: memoArg };
}

async function main(): Promise<void> {
  const { to, amount, memo } = parseArgs();
  const config = loadConfig();
  const wallet = await initWallet({ name: 'agent', nametagPrefix: nametagPrefixForRole('agent') }, config);
  const { sphere } = wallet;
  const recipient = to.startsWith('@') ? to : `@${to}`;

  const peer = await sphere.resolve(recipient);
  if (!peer) {
    log.error(SCOPE, `could not resolve "${recipient}" — check the nametag is correct and registered`);
    process.exitCode = 1;
    return;
  }
  log.info(SCOPE, `resolved ${recipient}: directAddress=${peer.directAddress}`);

  const ready = await TokenRegistry.waitForReady();
  if (!ready) log.warn(SCOPE, 'TokenRegistry did not report ready within timeout — coinId lookup below may be unreliable');

  const coinId = getCoinIdBySymbol('UCT');
  if (!coinId) {
    log.error(SCOPE, "getCoinIdBySymbol('UCT') returned undefined — resolve this via scripts/mint.ts first (it explains the options).");
    process.exitCode = 1;
    return;
  }
  const decimals = getTokenDecimals(coinId);
  const symbol = getTokenSymbol(coinId);
  const baseUnits = parseTokenAmount(amount, decimals);

  const balanceBefore = sphere.payments.getBalance(coinId);
  log.info(SCOPE, `agent balance before send: ${balanceBefore.map((a) => `${a.totalAmount} ${a.symbol}`).join(', ') || '(empty)'}`);
  if (balanceBefore.length === 0 || BigInt(balanceBefore[0]!.totalAmount) < baseUnits) {
    log.warn(SCOPE, 'agent balance looks insufficient for this send — mint into the agent wallet first: tsx scripts/mint.ts agent <amount>');
  }

  log.info(SCOPE, `sending ${amount} ${symbol} to ${recipient}${memo ? ` with memo=${JSON.stringify(memo)}` : ''}...`);

  try {
    const result = await sphere.payments.send({ coinId, amount: baseUnits.toString(), recipient, memo });
    log.info(
      SCOPE,
      `send() resolved: id=${result.id} status=${result.status} deliveryPending=${result.deliveryPending ?? false} deliveryState=${result.deliveryState ?? '(n/a)'}`,
    );
  } catch (err) {
    if (isSphereError(err)) {
      log.error(SCOPE, `send() threw SphereError code=${err.code}: ${err.message}`);
    } else {
      log.error(SCOPE, `send() threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
    await sphere.payments.waitForPendingOperations();
    process.exitCode = 1;
    return;
  }

  await sphere.payments.waitForPendingOperations();
  process.exit(0);
}

main().catch((err) => {
  log.error(SCOPE, `fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exitCode = 1;
});
