import { loadConfig, nametagPrefixForRole } from '../src/config.js';
import { initWallet, parseRoleArg } from '../src/wallet/init.js';
import { log } from '../src/logger.js';

const SCOPE = 'check-balance';
const USAGE = 'Usage: tsx scripts/check-balance.ts <role>';

async function main(): Promise<void> {
  const role = parseRoleArg(process.argv[2], USAGE);
  const config = loadConfig();
  const wallet = await initWallet({ name: role, nametagPrefix: nametagPrefixForRole(role) }, config);
  // Explicit drain before reading balance — getBalance() is synchronous over whatever the
  // wallet has already discovered; a short-lived CLI process may not have caught up on its
  // own yet (PHASE0_VERIFIED_API.md #5: receive() is exactly for "CLI/batch app that needs
  // explicit receive").
  const { transfers } = await wallet.sphere.payments.receive();
  if (transfers.length > 0) log.info(SCOPE, `receive() drained ${transfers.length} pending transfer(s)`);
  const balance = wallet.sphere.payments.getBalance();
  log.info(SCOPE, `${role} (@${wallet.nametag}) balance: ${balance.map((a) => `${a.totalAmount} ${a.symbol}`).join(', ') || '(empty)'}`);
  await wallet.sphere.payments.waitForPendingOperations();
  process.exit(0);
}

main().catch((err) => {
  log.error(SCOPE, `fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exitCode = 1;
});
