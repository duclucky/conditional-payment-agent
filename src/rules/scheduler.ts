import { log } from '../logger.js';
import type { RuleEngine } from './engine.js';

const SCOPE = 'scheduler';
const DEFAULT_TICK_MS = 30_000;

/**
 * Polls balance-triggered rules on a fixed interval — `onBalanceAbove`/`onBalanceBelow` have no
 * event to hang off of, unlike `onIncoming`. Every tick goes through `RuleEngine.runBalanceTick()`,
 * which is serialized behind the SAME queue as incoming-transfer handling
 * (PHASE3_PROCESS_DESIGN.md, Tầng 2a) — a tick can never interleave with an in-flight transfer.
 *
 * `onSchedule` (cron) rules are NOT evaluated here. CLAUDE.md itself calls this trigger type
 * weak ("không nên đứng một mình"), and implementing real cron parsing is out of scope for this
 * pass. If any enabled onSchedule rule exists, this logs a one-time warning rather than silently
 * never firing it — TODO for whoever picks this up next.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private warnedAboutSchedule = false;

  constructor(
    private readonly engine: RuleEngine,
    private readonly tickMs: number = DEFAULT_TICK_MS,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.tick().catch((err) => log.error(SCOPE, `tick failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));
    }, this.tickMs);
    log.info(SCOPE, `started — evaluating balance-triggered rules every ${this.tickMs}ms`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    const hasScheduleRules = this.engine.rules.list().some((r) => r.enabled && r.trigger.type === 'onSchedule');
    if (hasScheduleRules && !this.warnedAboutSchedule) {
      this.warnedAboutSchedule = true;
      log.warn(
        SCOPE,
        'one or more enabled onSchedule (cron) rules exist, but cron evaluation is not implemented — they will never fire. Only onBalanceAbove/onBalanceBelow rules are evaluated by this Scheduler.',
      );
    }
    await this.engine.runBalanceTick();
  }
}
