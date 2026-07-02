import type { IncomingTransfer } from '@unicitylabs/sphere-sdk';
import { log } from '../logger.js';
import { executeAction } from './executor.js';
import { checkGuards, type GuardContext } from './guards.js';
import { IdempotencyLog } from './idempotency.js';
import { matchBalanceRules, matchIncomingRules } from './matcher.js';
import { SplitProgressLog } from './split-progress.js';
import { RuleStore } from './store.js';
import type { AgentPort, IdentityResolverPort, Rule, SplitProgressPort } from './types.js';

const SCOPE = 'rule-engine';
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Orchestrates one full pass of the pipeline (CLAUDE.md 4.4-4.6):
 * event -> Rule Matcher -> Guard Check -> Action Executor -> state + idempotency.
 */
export class RuleEngine {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly agent: AgentPort,
    private readonly store: RuleStore,
    private readonly idempotency: IdempotencyLog,
    private readonly resolver: IdentityResolverPort,
    // No default here on purpose: a default pointing at the real store/ path would let a test
    // that forgets to override it silently write to the project's real split-progress.json.
    private readonly splitProgress: SplitProgressPort,
  ) {}

  static async load(agent: AgentPort, resolver: IdentityResolverPort): Promise<RuleEngine> {
    const store = await RuleStore.load();
    const idempotency = new IdempotencyLog();
    const splitProgress = await SplitProgressLog.load();
    return new RuleEngine(agent, store, idempotency, resolver, splitProgress);
  }

  get rules(): RuleStore {
    return this.store;
  }

  /**
   * Serializes ALL engine work — incoming-transfer events now, Scheduler ticks later — through
   * one promise chain (PHASE3_PROCESS_DESIGN.md, Tầng 2a). Without this, two `transfer:incoming`
   * events arriving close together can have their handler invocations interleave via awaited
   * I/O (e.g. one is mid-`send()`, which can take 10-30s — see SPLIT_REPORT.md — while another
   * event's guard check reads the same not-yet-updated rate-limit counter). That is a real bug
   * in a single process, not just a multi-process one: no operational mistake is needed to
   * trigger it, only two genuine transfers arriving close together.
   *
   * `.then(fn, fn)` runs `fn` regardless of whether the previous queued item succeeded or
   * failed, so one bad event never blocks later ones. IMPORTANT for future Scheduler work: tick
   * handling must go through this SAME queue (not a separate one), or this exact hazard
   * reappears between a tick and an in-flight transfer.
   */
  private runExclusive(fn: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(fn, fn);
    return this.queue;
  }

  private allDestinations(): string[] {
    const out: string[] = [];
    for (const rule of this.store.list()) {
      if (rule.action.type === 'forward') out.push(rule.action.to);
      else if (rule.action.type === 'split') out.push(...rule.action.splits.map((s) => s.to));
      else out.push(rule.action.to);
    }
    return out;
  }

  private async recordFire(rule: Rule): Promise<void> {
    const now = Date.now();
    const windowStarted = rule.state.windowStartedAt ?? 0;
    const stillInWindow = now - windowStarted < RATE_LIMIT_WINDOW_MS;
    rule.state.lastFiredAt = now;
    rule.state.fireCount += 1;
    rule.state.windowStartedAt = stillInWindow ? windowStarted : now;
    rule.state.firesInWindow = stillInWindow ? (rule.state.firesInWindow ?? 0) + 1 : 1;
    await this.store.saveState();
  }

  private async evaluate(rule: Rule, transfer: IncomingTransfer | undefined, destinations: readonly string[], agentChainPubkey: string): Promise<void> {
    const ctx: GuardContext = { resolver: this.resolver, agentChainPubkey, allRuleDestinations: destinations, transfer, now: Date.now() };
    const guardResult = await checkGuards(rule, ctx);
    if (!guardResult.allowed) {
      log.info(SCOPE, `rule ${rule.id} skipped: ${guardResult.reason}`);
      return;
    }

    const outcome = await executeAction(rule, this.agent, transfer, SCOPE, this.splitProgress);
    if (outcome.success) {
      await this.recordFire(rule);
      log.info(SCOPE, `rule ${rule.id} fired: ${outcome.detail}`);
    } else if (outcome.needsManualReview) {
      log.error(SCOPE, `MANUAL REVIEW NEEDED for rule ${rule.id} before this event can be retried: ${outcome.detail}`);
    } else {
      log.error(SCOPE, `rule ${rule.id} action failed, NOT marking as fired (fail-safe, controlled retry later): ${outcome.detail}`);
    }
  }

  async handleIncomingTransfer(transfer: IncomingTransfer): Promise<void> {
    return this.runExclusive(() => this.processIncoming(transfer));
  }

  /** Scheduler tick entry point (balance-triggered rules have no event to hang off of — they
   * need polling). Goes through the SAME runExclusive queue as handleIncomingTransfer, per the
   * design note above — a tick must never interleave with an in-flight transfer's guard/action
   * pipeline. */
  async runBalanceTick(): Promise<void> {
    return this.runExclusive(() => this.processBalanceRules());
  }

  private async processIncoming(transfer: IncomingTransfer): Promise<void> {
    // tryClaim() IS the idempotency mark — atomic, so there is no gap between "check" and
    // "act" for two callers racing on the SAME transfer.id (PHASE3_PROCESS_DESIGN.md, Tầng 2b).
    if (!(await this.idempotency.tryClaim(transfer.id))) {
      log.warn(SCOPE, `event ${transfer.id} already claimed — skipping (idempotency)`);
      return;
    }

    const agentChainPubkey = this.agent.identity?.chainPubkey;
    if (!agentChainPubkey) {
      log.error(SCOPE, 'agent identity has no chainPubkey — cannot safely evaluate guards, skipping event');
      return;
    }

    const destinations = this.allDestinations();

    const incomingCandidates = await matchIncomingRules(this.store.list(), transfer, { resolver: this.resolver });
    log.info(SCOPE, `event ${transfer.id}: ${incomingCandidates.length} onIncoming rule(s) matched`);
    for (const rule of incomingCandidates) {
      await this.evaluate(rule, transfer, destinations, agentChainPubkey);
    }

    // Also check balance rules right after a transfer lands — the common case (an incoming
    // payment pushing a balance over/under a threshold) reacts immediately instead of waiting
    // for the next Scheduler tick.
    await this.processBalanceRules();
  }

  private async processBalanceRules(): Promise<void> {
    const agentChainPubkey = this.agent.identity?.chainPubkey;
    if (!agentChainPubkey) {
      log.error(SCOPE, 'agent identity has no chainPubkey — cannot safely evaluate balance rules, skipping');
      return;
    }
    const destinations = this.allDestinations();

    const balanceCandidates = matchBalanceRules(this.store.list(), (coinId) => {
      const [asset] = this.agent.payments.getBalance(coinId);
      return asset ? BigInt(asset.totalAmount) : 0n;
    });
    for (const rule of balanceCandidates) {
      await this.evaluate(rule, undefined, destinations, agentChainPubkey);
    }
  }
}
