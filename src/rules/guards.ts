import type { IncomingTransfer } from '@unicitylabs/sphere-sdk';
import { sumIncomingByCoin } from '../payments/incoming.js';
import type { IdentityResolverPort, Rule } from './types.js';

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

export interface GuardContext {
  readonly resolver: IdentityResolverPort;
  /** The agent's own chainPubkey — checked synchronously, no resolve() needed. */
  readonly agentChainPubkey: string;
  /** Every action destination across ALL rules (not just this one) — a rule forwarding to X
   * must not later fire again because X's wallet sent something back that matches a DIFFERENT
   * rule too; CLAUDE.md 4.4 #1 calls for "mọi đích của luật" as a blanket loop guard. */
  readonly allRuleDestinations: readonly string[];
  /** Present only when evaluating an onIncoming-triggered candidate. */
  readonly transfer?: IncomingTransfer;
  readonly now: number;
}

export interface GuardResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

/**
 * Seconds left before `rule`'s cooldown clears, or 0 if no cooldown is configured/active.
 * Pulled out of checkGuards so the dashboard (Phase 4) can show the exact same number to a
 * reviewer that the enforcement path itself uses — a duplicated copy would silently drift the
 * two if cooldown math ever changed here.
 */
export function cooldownRemainingSeconds(rule: Pick<Rule, 'guards' | 'state'>, now: number): number {
  if (!rule.guards.cooldownSeconds || !rule.state.lastFiredAt) return 0;
  const elapsedMs = now - rule.state.lastFiredAt;
  const remainingMs = rule.guards.cooldownSeconds * 1000 - elapsedMs;
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
}

/**
 * Guard Check (CLAUDE.md 4.4): cooldown, rate limit, minAmount, and loop protection.
 * Loop protection (agent-self + rule destinations) is NOT user-configurable off — it always
 * runs in addition to any explicit `guards.excludeSenders`.
 */
export async function checkGuards(rule: Rule, ctx: GuardContext): Promise<GuardResult> {
  const cooldownRemaining = cooldownRemainingSeconds(rule, ctx.now);
  if (cooldownRemaining > 0) {
    return { allowed: false, reason: `cooldown active (${cooldownRemaining}s remaining)` };
  }

  if (rule.guards.maxTriggersPerHour !== undefined) {
    const windowStarted = rule.state.windowStartedAt ?? 0;
    const stillInWindow = ctx.now - windowStarted < RATE_LIMIT_WINDOW_MS;
    const firesInWindow = stillInWindow ? rule.state.firesInWindow ?? 0 : 0;
    if (firesInWindow >= rule.guards.maxTriggersPerHour) {
      return { allowed: false, reason: `maxTriggersPerHour reached (${rule.guards.maxTriggersPerHour}/hour)` };
    }
  }

  if (ctx.transfer) {
    if (rule.guards.minAmount) {
      const totals = sumIncomingByCoin(ctx.transfer);
      const min = BigInt(rule.guards.minAmount);
      const meetsMin = totals.some((t) => t.totalAmount >= min);
      if (!meetsMin) return { allowed: false, reason: `amount below minAmount (${rule.guards.minAmount})` };
    }

    if (ctx.transfer.senderPubkey === ctx.agentChainPubkey) {
      return { allowed: false, reason: 'sender is the agent itself (loop protection)' };
    }

    const protectedIdentifiers = [...(rule.guards.excludeSenders ?? []), ...ctx.allRuleDestinations];
    for (const identifier of protectedIdentifiers) {
      const resolved = await ctx.resolver.resolveChainPubkey(identifier);
      if (resolved && resolved === ctx.transfer.senderPubkey) {
        return { allowed: false, reason: `sender matches a protected identity ("${identifier}") — excludeSenders / loop protection` };
      }
    }
  }

  return { allowed: true };
}
