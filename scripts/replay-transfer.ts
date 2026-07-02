import type { IncomingTransfer, Token } from '@unicitylabs/sphere-sdk';
import { loadConfig, nametagPrefixForRole } from '../src/config.js';
import { log } from '../src/logger.js';
import { RuleEngine } from '../src/rules/engine.js';
import { IdentityResolver } from '../src/rules/identity-cache.js';
import { initWallet } from '../src/wallet/init.js';

const SCOPE = 'replay-transfer';

/**
 * Feeds a synthetic IncomingTransfer straight into the agent's RuleEngine, bypassing the live
 * SDK event entirely. Exists ONLY to test crash-recovery paths on real infrastructure without
 * needing to reproduce an actual process crash — combine with manually editing
 * store/idempotency.json (remove the transfer.id entry) and store/split-progress.json (set a
 * leg back to 'sending') to simulate "process died between the checkpoint flush and send()
 * resolving" (SPLIT_DESIGN_V2.md). Do not run this against a transfer.id that a live agent
 * process might independently be handling — same one-wallet-one-process rule as everywhere else.
 */
function parseArgs(): { transferId: string; senderPubkey: string; coinId: string; amount: string; memo?: string } {
  const [transferId, senderPubkey, coinId, amount, memo] = process.argv.slice(2);
  if (!transferId || !senderPubkey || !coinId || !amount) {
    throw new Error('Usage: tsx scripts/replay-transfer.ts <transferId> <senderPubkey> <coinId> <amount> [memo]');
  }
  return { transferId, senderPubkey, coinId, amount, memo };
}

async function main(): Promise<void> {
  const { transferId, senderPubkey, coinId, amount, memo } = parseArgs();
  const config = loadConfig();
  const wallet = await initWallet({ name: 'agent', nametagPrefix: nametagPrefixForRole('agent') }, config);
  const { sphere } = wallet;

  const resolver = new IdentityResolver(sphere);
  const engine = await RuleEngine.load(sphere, resolver);

  const token: Token = { id: `replay-${transferId}`, coinId, symbol: 'UCT', name: 'UCT', decimals: 18, amount, status: 'confirmed', createdAt: 0, updatedAt: 0 };
  const transfer: IncomingTransfer = { id: transferId, senderPubkey, tokens: [token], memo, receivedAt: Date.now() };

  log.warn(SCOPE, `REPLAYING transfer.id=${transferId} — synthetic event, bypasses the live SDK, for crash-recovery testing only`);
  await engine.handleIncomingTransfer(transfer);

  await sphere.payments.waitForPendingOperations();
  process.exit(0);
}

main().catch((err) => {
  log.error(SCOPE, `fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exitCode = 1;
});
