import { TokenRegistry, getCoinIdBySymbol, parseTokenAmount } from '@unicitylabs/sphere-sdk';
import { loadConfig, nametagPrefixForRole } from '../src/config.js';
import { log } from '../src/logger.js';
import { RuleStore } from '../src/rules/store.js';
import type { NewRuleInput } from '../src/rules/store.js';
import { initWallet, peekNametag } from '../src/wallet/init.js';

const SCOPE = 'add-rule';
const PRESETS = ['forward-normal', 'forward-oversized', 'split-with-invalid-leg', 'notify-on-incoming', 'balance-above'] as const;
type Preset = (typeof PRESETS)[number];

function parseArgs(): { preset: Preset; arg?: string } {
  const [presetArg, extra] = process.argv.slice(2);
  if (!PRESETS.includes(presetArg as Preset)) {
    throw new Error(`Usage: tsx scripts/add-rule.ts <${PRESETS.join('|')}> [arg]\n  balance-above takes a threshold in whole UCT, e.g.: balance-above 1`);
  }
  return { preset: presetArg as Preset, arg: extra };
}

async function main(): Promise<void> {
  const { preset, arg } = parseArgs();
  const config = loadConfig();

  // Ensure the partner wallet exists (idempotent: loads if already created) — it's the forward
  // destination for both presets, distinct from the counterparty (the trigger sender) so the
  // test actually exercises destination resolution, not just "send back to whoever sent it".
  const partner = await initWallet({ name: 'partner', nametagPrefix: nametagPrefixForRole('partner') }, config);
  if (!partner.nametag) throw new Error('partner wallet has no registered nametag — cannot seed a forward rule without a destination');
  log.info(SCOPE, `partner wallet: @${partner.nametag} (${partner.sphere.identity?.directAddress})`);

  const counterpartyNametag = await peekNametag('counterparty');
  if (!counterpartyNametag) {
    throw new Error('no counterparty nametag found — run scripts/mint.ts counterparty <amount> at least once first (Phase 1)');
  }
  log.info(SCOPE, `counterparty (trigger sender): @${counterpartyNametag}`);

  const ready = await TokenRegistry.waitForReady();
  if (!ready) log.warn(SCOPE, 'TokenRegistry did not report ready within timeout — coinId lookup below may be unreliable');
  const coinId = getCoinIdBySymbol('UCT');
  if (!coinId) throw new Error("getCoinIdBySymbol('UCT') returned undefined — run scripts/mint.ts to investigate first");

  const store = await RuleStore.load();

  let input: NewRuleInput;
  if (preset === 'forward-normal') {
    input = {
      enabled: true,
      trigger: { type: 'onIncoming', fromSender: `@${counterpartyNametag}`, minIncoming: parseTokenAmount('0.1', 18).toString() },
      action: { type: 'forward', to: `@${partner.nametag}`, percent: 10, coinId, memo: 'phase2-auto-forward' },
      guards: { minAmount: parseTokenAmount('0.1', 18).toString(), maxTriggersPerHour: 10, cooldownSeconds: 5 },
    };
  } else if (preset === 'forward-oversized') {
    // Deliberately larger than the agent will ever hold — for the mandatory real fail-safe
    // test (PHASE2_REPORT.md): forward a fixedAmount the agent cannot cover.
    input = {
      enabled: true,
      trigger: { type: 'onIncoming', fromSender: `@${counterpartyNametag}` },
      action: { type: 'forward', to: `@${partner.nametag}`, fixedAmount: parseTokenAmount('999999', 18).toString(), coinId, memo: 'phase2-fail-safe-test' },
      guards: {},
    };
  } else if (preset === 'split-with-invalid-leg') {
    // leg 0 (partner) is a real, valid recipient — should succeed and checkpoint as 'sent'.
    // Leg 1 targets a nametag that is well-formed but certainly unregistered, forcing a clean
    // INVALID_RECIPIENT failure (SPLIT_DESIGN_V2.md §8 — preferred over an oversized amount,
    // which triggers the SDK's self-healing retry storm seen in Phase 2 and makes the leg-level
    // outcome harder to observe cleanly).
    input = {
      enabled: true,
      trigger: { type: 'onIncoming', fromSender: `@${counterpartyNametag}` },
      action: {
        type: 'split',
        coinId,
        splits: [
          { to: `@${partner.nametag}`, percent: 40 },
          { to: '@nonexistent-test-leg', percent: 40 },
        ],
      },
      guards: {},
    };
  } else if (preset === 'notify-on-incoming') {
    // Phase 3: first real test of the `notify` action (sendDM) — not exercised in Phase 2.
    input = {
      enabled: true,
      trigger: { type: 'onIncoming', fromSender: `@${counterpartyNametag}` },
      action: { type: 'notify', to: `@${partner.nametag}`, message: 'phase3-notify-test: incoming transfer received' },
      guards: {},
    };
  } else {
    // balance-above: Phase 3's first real test of the Scheduler's balance-tick polling path
    // (onBalanceAbove/Below have no event to hang off of). `arg` is a whole-UCT threshold —
    // pick one BELOW the agent's current balance so it fires on the very first tick.
    if (!arg) throw new Error('balance-above requires a threshold argument, e.g.: tsx scripts/add-rule.ts balance-above 1');
    input = {
      enabled: true,
      trigger: { type: 'onBalanceAbove', threshold: parseTokenAmount(arg, 18).toString(), coinId },
      action: { type: 'notify', to: `@${partner.nametag}`, message: `phase3-balance-test: balance above ${arg} UCT` },
      guards: { cooldownSeconds: 60 }, // level-triggered (fires every tick while true) — cooldown prevents spam during testing
    };
  }

  const rule = await store.add(input);
  log.info(SCOPE, `added rule ${rule.id} (${preset}): ${JSON.stringify(rule, null, 2)}`);

  await partner.sphere.payments.waitForPendingOperations();
  process.exit(0);
}

main().catch((err) => {
  log.error(SCOPE, `fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exitCode = 1;
});
