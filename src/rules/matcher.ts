import type { IncomingTransfer } from '@unicitylabs/sphere-sdk';
import { sumIncomingByCoin } from '../payments/incoming.js';
import type { IdentityResolverPort, Rule } from './types.js';

export interface MatchContext {
  readonly resolver: IdentityResolverPort;
}

/**
 * Rule Matcher (CLAUDE.md 4.6) for `onIncoming` triggers — sender + amount conditions only.
 * Guard Check (separate module) handles rate limits, cooldowns, and loop protection; keeping
 * "does this rule apply at all" separate from "is it currently allowed to fire" mirrors the
 * pipeline order in CLAUDE.md 4.4-4.6.
 */
export async function matchIncomingRules(rules: readonly Rule[], transfer: IncomingTransfer, ctx: MatchContext): Promise<Rule[]> {
  const totals = sumIncomingByCoin(transfer);
  const matched: Rule[] = [];

  for (const rule of rules) {
    if (!rule.enabled || rule.trigger.type !== 'onIncoming') continue;

    if (rule.trigger.fromSender) {
      const expected = await ctx.resolver.resolveChainPubkey(rule.trigger.fromSender);
      if (!expected || expected !== transfer.senderPubkey) continue;
    }

    if (rule.trigger.minIncoming) {
      const min = BigInt(rule.trigger.minIncoming);
      const meetsThreshold = totals.some((t) => t.totalAmount >= min);
      if (!meetsThreshold) continue;
    }

    matched.push(rule);
  }

  return matched;
}

/** Balance-threshold rules (`onBalanceAbove` / `onBalanceBelow`) — checked against current balance. */
export function matchBalanceRules(rules: readonly Rule[], getBalance: (coinId: string) => bigint): Rule[] {
  const matched: Rule[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.trigger.type !== 'onBalanceAbove' && rule.trigger.type !== 'onBalanceBelow') continue;

    const current = getBalance(rule.trigger.coinId);
    const threshold = BigInt(rule.trigger.threshold);
    const satisfied = rule.trigger.type === 'onBalanceAbove' ? current > threshold : current < threshold;
    if (satisfied) matched.push(rule);
  }

  return matched;
}
