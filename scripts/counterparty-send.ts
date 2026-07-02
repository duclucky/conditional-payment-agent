import { TokenRegistry, getCoinIdBySymbol, getTokenDecimals, getTokenSymbol, parseTokenAmount, isSphereError } from '@unicitylabs/sphere-sdk';
import { loadConfig, nametagPrefixForRole } from '../src/config.js';
import { initWallet, peekNametag } from '../src/wallet/init.js';
import { log } from '../src/logger.js';

const SCOPE = 'counterparty-send';

function parseArgs(): { amount: string; memo: string; toOverride?: string } {
  const [amountArg, memoArg, toArg] = process.argv.slice(2);
  if (!amountArg || !memoArg) {
    throw new Error('Usage: tsx scripts/counterparty-send.ts <amount> <memo> [agentNametag]');
  }
  return { amount: amountArg, memo: memoArg, toOverride: toArg };
}

/**
 * Drives Phase 1 verification results (a) sender-identity matching and (b) memo observation:
 * sends FROM the counterparty test wallet TO the agent's nametag with a caller-supplied memo,
 * so scripts/run-agent-wallet.ts's live listener can log what actually arrived.
 */
async function main(): Promise<void> {
  const { amount, memo, toOverride } = parseArgs();
  const config = loadConfig();
  const wallet = await initWallet({ name: 'counterparty', nametagPrefix: nametagPrefixForRole('counterparty') }, config);
  const { sphere } = wallet;

  log.info(
    SCOPE,
    `wallet ready: directAddress=${sphere.identity?.directAddress} nametag=${wallet.nametag ? '@' + wallet.nametag : '(none)'} chainPubkey=${sphere.identity?.chainPubkey}`,
  );

  const agentNametag = toOverride ?? process.env.AGENT_NAMETAG ?? (await peekNametag('agent'));
  if (!agentNametag) {
    log.error(SCOPE, 'no agent nametag known — run scripts/run-agent-wallet.ts at least once first, or pass one explicitly:');
    log.error(SCOPE, '  tsx scripts/counterparty-send.ts <amount> <memo> <agentNametag>');
    process.exitCode = 1;
    return;
  }

  const agentPeer = await sphere.resolve(`@${agentNametag}`);
  if (!agentPeer) {
    log.error(SCOPE, `could not resolve @${agentNametag} — is the agent wallet's nametag registered and propagated on Nostr yet?`);
    process.exitCode = 1;
    return;
  }
  log.info(
    SCOPE,
    `resolved agent @${agentNametag}: directAddress=${agentPeer.directAddress} chainPubkey=${agentPeer.chainPubkey} transportPubkey=${agentPeer.transportPubkey}`,
  );

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
  log.info(SCOPE, `balance before send: ${balanceBefore.map((a) => `${a.totalAmount} ${a.symbol}`).join(', ') || '(empty)'}`);

  log.info(SCOPE, `sending ${amount} ${symbol} (${baseUnits} base units) to @${agentNametag} with memo=${JSON.stringify(memo)}...`);

  try {
    const result = await sphere.payments.send({
      coinId,
      amount: baseUnits.toString(),
      recipient: `@${agentNametag}`,
      memo,
    });
    log.info(
      SCOPE,
      `send() resolved: id=${result.id} status=${result.status} deliveryPending=${result.deliveryPending ?? false} deliveryState=${result.deliveryState ?? '(n/a)'}`,
    );
    if (result.status !== 'completed') {
      log.warn(SCOPE, `status is "${result.status}", not "completed" — check the agent's log for transfer:incoming / transfer:failed`);
    }
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
  log.info(SCOPE, 'done — check scripts/run-agent-wallet.ts output for the transfer:incoming log line and sender-match result.');
  process.exit(0);
}

main().catch((err) => {
  log.error(SCOPE, `fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exitCode = 1;
});
