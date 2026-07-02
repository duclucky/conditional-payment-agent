import { log } from '../src/logger.js';
import { RuleStore } from '../src/rules/store.js';

const SCOPE = 'set-rule-enabled';

function parseArgs(): { ruleId: string; enabled: boolean } {
  const [ruleId, enabledArg] = process.argv.slice(2);
  if (!ruleId || (enabledArg !== 'true' && enabledArg !== 'false')) {
    throw new Error('Usage: tsx scripts/set-rule-enabled.ts <ruleId> <true|false>');
  }
  return { ruleId, enabled: enabledArg === 'true' };
}

async function main(): Promise<void> {
  const { ruleId, enabled } = parseArgs();
  const store = await RuleStore.load();
  await store.setEnabled(ruleId, enabled);
  log.info(SCOPE, `rule ${ruleId} enabled=${enabled}`);
}

main().catch((err) => {
  log.error(SCOPE, `fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exitCode = 1;
});
