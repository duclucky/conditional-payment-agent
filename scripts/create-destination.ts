import { loadConfig } from '../src/config.js';
import { log } from '../src/logger.js';
import { initWallet, validateNametagFormat } from '../src/wallet/init.js';

const SCOPE = 'create-destination';

function parseArgs(): { nametag: string } {
  const [nametag] = process.argv.slice(2);
  if (!nametag) throw new Error('Usage: tsx scripts/create-destination.ts <nametag>\n  e.g.: tsx scripts/create-destination.ts ducky-fee');
  return { nametag };
}

/**
 * Creates a brand-new wallet under `data/<nametag>/` + `tokens/<nametag>/` (its own role, its
 * own process-lock — never touches `data/agent/`) and registers the EXACT nametag requested.
 * Used to set up branded destination wallets for demo rules (e.g. @ducky-fee, @ducky-savings)
 * instead of the random-suffix nametags scripts/add-rule.ts generates for its own test wallets.
 */
async function main(): Promise<void> {
  const { nametag } = parseArgs();
  validateNametagFormat(nametag);

  const config = loadConfig();
  const wallet = await initWallet({ name: nametag, nametagPrefix: 'dest', exactNametag: nametag }, config);

  log.info(
    SCOPE,
    `destination wallet ready: nametag=${wallet.nametag ? '@' + wallet.nametag : '(none — see errors above)'} ` +
      `directAddress=${wallet.sphere.identity?.directAddress ?? '(unknown)'} chainPubkey=${wallet.sphere.identity?.chainPubkey ?? '(unknown)'}`,
  );

  process.exit(0);
}

main().catch((err) => {
  log.error(SCOPE, `fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exitCode = 1;
});
