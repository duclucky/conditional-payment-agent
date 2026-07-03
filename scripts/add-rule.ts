import { TokenRegistry, getCoinIdBySymbol, parseTokenAmount } from '@unicitylabs/sphere-sdk';
import { loadConfig, nametagPrefixForRole } from '../src/config.js';
import { log } from '../src/logger.js';
import { RuleStore } from '../src/rules/store.js';
import type { NewRuleInput } from '../src/rules/store.js';
import { initWallet, peekNametag } from '../src/wallet/init.js';

const SCOPE = 'add-rule';

// Ducky demo presets (branded destination nametags — see scripts/create-destination.ts — open to
// ANY sender, not a fixed test counterparty, since these are meant for a real external reviewer
// to trigger). Unlike the presets below, these need no wallet/TokenRegistry lookup at all: the
// coinId is a well-known constant already used throughout this project (CLAUDE.md, rules.json,
// every prior phase report), so adding one of these is pure filesystem I/O on rules.json.
const DUCKY_PRESETS = ['notify-incoming', 'forward-fee', 'split-departments', 'conditional-forward', 'balance-watch'] as const;
const UCT_COIN_ID = 'f581d30f593e4b369d684a4563b5246f07b1d265f7178a2c0a82b81f39c24dc0';

const PRESETS = ['forward-normal', 'forward-oversized', 'split-with-invalid-leg', 'notify-on-incoming', 'balance-above', ...DUCKY_PRESETS] as const;
type Preset = (typeof PRESETS)[number];

function isDuckyPreset(preset: Preset): preset is (typeof DUCKY_PRESETS)[number] {
  return (DUCKY_PRESETS as readonly string[]).includes(preset);
}

function parseArgs(): { preset: Preset; arg?: string } {
  const [presetArg, extra] = process.argv.slice(2);
  if (!PRESETS.includes(presetArg as Preset)) {
    throw new Error(
      `Usage: tsx scripts/add-rule.ts <${PRESETS.join('|')}> [arg]\n` +
        '  balance-above takes a threshold in whole UCT, e.g.: balance-above 1\n' +
        '  balance-watch takes an optional threshold in whole UCT, default 15, e.g.: balance-watch 20',
    );
  }
  return { preset: presetArg as Preset, arg: extra };
}

function uctAmount(whole: string): string {
  return parseTokenAmount(whole, 18).toString();
}

/**
 * The 5 fixed demo rules for the @ducky-* branded destination wallets. All ship `enabled: false`
 * — a reviewer opts each one in via the dashboard, they never fire on their own after seeding.
 */
function buildDuckyRule(preset: (typeof DUCKY_PRESETS)[number], arg: string | undefined): NewRuleInput {
  switch (preset) {
    case 'notify-incoming':
      return {
        enabled: false,
        trigger: { type: 'onIncoming', minIncoming: uctAmount('1') },
        action: { type: 'notify', to: '@ducky-alerts', message: 'Agent detected an incoming transfer' },
        guards: { minAmount: uctAmount('1') },
      };
    case 'forward-fee':
      return {
        enabled: false,
        trigger: { type: 'onIncoming', minIncoming: uctAmount('1') },
        action: { type: 'forward', to: '@ducky-fee', percent: 10, coinId: UCT_COIN_ID },
        guards: { minAmount: uctAmount('1') },
      };
    case 'split-departments':
      return {
        enabled: false,
        trigger: { type: 'onIncoming', minIncoming: uctAmount('1') },
        action: {
          type: 'split',
          coinId: UCT_COIN_ID,
          splits: [
            { to: '@ducky-savings', percent: 50 },
            { to: '@ducky-ops', percent: 30 },
            { to: '@ducky-charity', percent: 20 },
          ],
        },
        guards: { minAmount: uctAmount('1') },
      };
    case 'conditional-forward':
      // Only fires on incoming >= 5 UCT — same event below that threshold matches nothing here,
      // so a reviewer can demo both "too small, no reaction" and "big enough, forwards" paths.
      return {
        enabled: false,
        trigger: { type: 'onIncoming', minIncoming: uctAmount('5') },
        action: { type: 'forward', to: '@ducky-savings', percent: 100, coinId: UCT_COIN_ID },
        guards: { minAmount: uctAmount('5') },
      };
    case 'balance-watch': {
      const threshold = arg ?? '15';
      return {
        enabled: false,
        trigger: { type: 'onBalanceAbove', threshold: uctAmount(threshold), coinId: UCT_COIN_ID },
        action: { type: 'notify', to: '@ducky-alerts', message: 'Agent balance exceeded threshold' },
        // Level-triggered (re-checked every Scheduler tick while true) — cooldown avoids spam,
        // matching the existing balance-above preset's already-proven pattern.
        guards: { cooldownSeconds: 60 },
      };
    }
  }
}

async function main(): Promise<void> {
  const { preset, arg } = parseArgs();
  const store = await RuleStore.load();

  if (isDuckyPreset(preset)) {
    const input = buildDuckyRule(preset, arg);
    const rule = await store.add(input);
    log.info(SCOPE, `added rule ${rule.id} (${preset}): ${JSON.stringify(rule, null, 2)}`);
    process.exit(0);
  }

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
