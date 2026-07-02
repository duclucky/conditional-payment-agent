import { loadConfig, nametagPrefixForRole } from '../src/config.js';
import { log } from '../src/logger.js';
import { initWallet, parseRoleArg } from '../src/wallet/init.js';

const SCOPE = 'check-dms';
const USAGE = 'Usage: tsx scripts/check-dms.ts <role>';

async function main(): Promise<void> {
  const role = parseRoleArg(process.argv[2], USAGE);
  const config = loadConfig();
  const wallet = await initWallet({ name: role, nametagPrefix: nametagPrefixForRole(role) }, config);

  const conversations = wallet.sphere.communications.getConversations();
  if (conversations.size === 0) {
    log.info(SCOPE, `${role}: no conversations found`);
  }
  for (const [peer, messages] of conversations) {
    log.info(SCOPE, `${role}: conversation with ${peer} (${messages.length} message(s)):`);
    for (const msg of messages) {
      log.info(SCOPE, `  [${new Date(msg.timestamp).toISOString()}] from ${msg.senderNametag ?? msg.senderPubkey}: ${JSON.stringify(msg.content)}`);
    }
  }

  await wallet.sphere.payments.waitForPendingOperations();
  process.exit(0);
}

main().catch((err) => {
  log.error(SCOPE, `fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exitCode = 1;
});
