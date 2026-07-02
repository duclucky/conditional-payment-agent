import type { IncomingTransfer, PeerInfo, TransferResult } from '@unicitylabs/sphere-sdk';
import { loadConfig, nametagPrefixForRole } from '../src/config.js';
import { initWallet, peekNametag } from '../src/wallet/init.js';
import { log } from '../src/logger.js';
import { formatCoinTotals, sumIncomingByCoin } from '../src/payments/incoming.js';

const SCOPE = 'agent';

async function main(): Promise<void> {
  const config = loadConfig();
  const wallet = await initWallet({ name: 'agent', nametagPrefix: nametagPrefixForRole('agent') }, config);
  const { sphere } = wallet;

  log.info(SCOPE, `directAddress = ${sphere.identity?.directAddress}`);
  log.info(SCOPE, `nametag       = ${wallet.nametag ? '@' + wallet.nametag : '(none registered)'}`);
  log.info(SCOPE, `chainPubkey   = ${sphere.identity?.chainPubkey}`);
  log.info(SCOPE, `deviceId      = ${wallet.deviceId}`);

  const balance = sphere.payments.getBalance();
  log.info(SCOPE, `balance at startup = ${balance.length === 0 ? '(empty)' : balance.map((a) => `${a.totalAmount} ${a.symbol}`).join(', ')}`);

  // Resolve the counterparty's PeerInfo up front (if that test wallet already exists on this
  // machine) so each incoming transfer's senderPubkey can be checked against it live. This is
  // the exact identity-matching Phase 2's Rule Matcher will need for `fromSender` guards —
  // Phase 1 result (a).
  const counterpartyNametag = process.env.COUNTERPARTY_NAMETAG ?? (await peekNametag('counterparty'));
  let counterpartyPeer: PeerInfo | null = null;
  if (counterpartyNametag) {
    counterpartyPeer = await sphere.resolve(`@${counterpartyNametag}`);
    if (counterpartyPeer) {
      log.info(
        SCOPE,
        `resolved counterparty @${counterpartyNametag}: chainPubkey=${counterpartyPeer.chainPubkey} transportPubkey=${counterpartyPeer.transportPubkey}`,
      );
    } else {
      log.warn(SCOPE, `could not resolve @${counterpartyNametag} yet (binding may not have propagated) — sender-match check will be skipped`);
    }
  } else {
    log.warn(SCOPE, 'no counterparty nametag known yet (run scripts/mint.ts counterparty first) — sender-match check will be skipped');
  }

  sphere.on('transfer:incoming', (transfer: IncomingTransfer) => {
    const totals = sumIncomingByCoin(transfer);
    log.info(
      SCOPE,
      `transfer:incoming id=${transfer.id} senderPubkey=${transfer.senderPubkey} senderNametag=${transfer.senderNametag ?? '(none)'} memo=${JSON.stringify(transfer.memo ?? null)} tokens=${formatCoinTotals(totals)}`,
    );

    if (counterpartyPeer) {
      const matchesChain = counterpartyPeer.chainPubkey === transfer.senderPubkey;
      const matchesTransport = counterpartyPeer.transportPubkey === transfer.senderPubkey;
      log.info(SCOPE, `sender-match check: chainPubkey match=${matchesChain}, transportPubkey match=${matchesTransport}`);
    }
  });

  sphere.on('transfer:confirmed', (result: TransferResult) => {
    log.info(SCOPE, `transfer:confirmed id=${result.id} status=${result.status}`);
  });

  sphere.on('transfer:delivery_pending', (result: TransferResult) => {
    log.info(SCOPE, `transfer:delivery_pending id=${result.id} status=${result.status} — SUCCESS, delivery deferred (not an error)`);
  });

  sphere.on('transfer:failed', (result: TransferResult) => {
    log.error(SCOPE, `transfer:failed id=${result.id} error=${result.error ?? '(no error message)'}`);
  });

  log.info(SCOPE, 'listening for transfer:incoming — leave this running, Ctrl+C to stop');
  await new Promise<never>(() => {
    // Keep the process alive: the delivery port's background poll/wake needs a live event
    // loop, not a one-shot script exit. Default SIGINT handling (Ctrl+C) still terminates.
  });
}

main().catch((err) => {
  log.error(SCOPE, `fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exitCode = 1;
});
