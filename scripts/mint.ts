import { TokenRegistry, getCoinIdBySymbol, getTokenDecimals, getTokenSymbol, parseTokenAmount } from '@unicitylabs/sphere-sdk';
import { loadConfig, nametagPrefixForRole } from '../src/config.js';
import { initWallet, parseRoleArg } from '../src/wallet/init.js';
import { log } from '../src/logger.js';

const SCOPE = 'mint';
const USAGE = 'Usage: tsx scripts/mint.ts <role> <amount> [symbol=UCT]';

function parseArgs(): { role: string; amount: string; symbol: string } {
  const [roleArg, amountArg, symbolArg] = process.argv.slice(2);
  const role = parseRoleArg(roleArg, USAGE);
  if (!amountArg) throw new Error(USAGE);
  return { role, amount: amountArg, symbol: symbolArg ?? 'UCT' };
}

async function main(): Promise<void> {
  const { role, amount, symbol } = parseArgs();
  const config = loadConfig();
  const wallet = await initWallet({ name: role, nametagPrefix: nametagPrefixForRole(role) }, config);

  log.info(SCOPE, `wallet ready: directAddress=${wallet.sphere.identity?.directAddress} nametag=${wallet.nametag ? '@' + wallet.nametag : '(none)'}`);

  // TokenRegistry keeps fetching testnet2 definitions in the background even after
  // Sphere.init configures it — waitForReady avoids a false "not found" from reading it
  // too early (PHASE0_VERIFIED_API.md #9 / TokenRegistry's documented data-flow comment).
  const ready = await TokenRegistry.waitForReady();
  if (!ready) {
    log.warn(SCOPE, 'TokenRegistry did not report ready within its timeout — the lookup below may be unreliable, not a confirmed miss.');
  }

  const coinId = getCoinIdBySymbol(symbol);
  if (!coinId) {
    log.error(SCOPE, `getCoinIdBySymbol('${symbol}') returned undefined after TokenRegistry.waitForReady() — '${symbol}' is not in the testnet2 registry (or the fetch failed).`);
    log.error(SCOPE, 'STOPPING rather than guessing a coinId hex. Two options — please choose:');
    log.error(SCOPE, '  1) Check the live registry and confirm the exact symbol/coinId to use:');
    log.error(SCOPE, '     https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/unicity-ids.testnet2.json');
    log.error(SCOPE, '  2) Or: mintFungibleToken accepts ANY even-length hex coinId — it does not require');
    log.error(SCOPE, '     registry presence (only symbol lookup does). We could mint a project-specific test');
    log.error(SCOPE, '     coinId instead if you confirm you want that.');
    process.exitCode = 1;
    return;
  }

  const decimals = getTokenDecimals(coinId);
  const resolvedSymbol = getTokenSymbol(coinId);
  const baseUnits = parseTokenAmount(amount, decimals);

  log.info(SCOPE, `minting ${amount} ${resolvedSymbol} — coinId=${coinId} decimals=${decimals} baseUnits=${baseUnits}`);

  const result = await wallet.sphere.payments.mintFungibleToken(coinId, baseUnits);
  if (!result.success) {
    log.error(SCOPE, `mint failed: ${result.error}`);
    await wallet.sphere.payments.waitForPendingOperations();
    process.exitCode = 1;
    return;
  }

  log.info(SCOPE, `mint OK — tokenId=${result.tokenId}`);
  const balance = wallet.sphere.payments.getBalance(coinId);
  log.info(SCOPE, `balance now: ${balance.map((a) => `${a.totalAmount} ${a.symbol}`).join(', ') || '(empty)'}`);

  await wallet.sphere.payments.waitForPendingOperations();
  process.exit(0);
}

main().catch((err) => {
  log.error(SCOPE, `fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exitCode = 1;
});
