import type { IncomingTransfer, TransferResult } from '@unicitylabs/sphere-sdk';
import { isSphereError } from '@unicitylabs/sphere-sdk';
import { log } from '../logger.js';
import { sumIncomingByCoin } from '../payments/incoming.js';
import type { AgentPort, ForwardAction, Rule, SplitAction, SplitProgressPort } from './types.js';

export interface ExecutionOutcome {
  /** true = mark the rule as fired (send completed OR certified-with-deferred-delivery). */
  readonly success: boolean;
  readonly detail: string;
  readonly transferResults?: readonly TransferResult[];
  /** true = a split leg is stuck at 'sending' from a prior crash — do NOT auto-retry (SPLIT_DESIGN_V2.md). */
  readonly needsManualReview?: boolean;
}

/** Used when the caller doesn't care about split checkpointing (forward/notify, or tests). */
const NOOP_PROGRESS: SplitProgressPort = {
  getLeg: () => undefined,
  markLegSending: async () => {},
  markLegSent: async () => {},
  clearLeg: async () => {},
};

function receivedAmountForCoin(transfer: IncomingTransfer | undefined, coinId: string): bigint {
  if (!transfer) return 0n;
  return sumIncomingByCoin(transfer).find((t) => t.coinId === coinId)?.totalAmount ?? 0n;
}

function computeAmount(spec: { readonly percent?: number; readonly fixedAmount?: string }, receivedAmount: bigint): bigint {
  if (spec.fixedAmount !== undefined) return BigInt(spec.fixedAmount);
  if (spec.percent !== undefined) return (receivedAmount * BigInt(spec.percent)) / 100n;
  throw new Error('action needs either percent or fixedAmount');
}

type SendOutcome = { readonly ok: true; readonly result: TransferResult } | { readonly ok: false; readonly error: string };

/**
 * `status: 'failed'` and a thrown SphereError/other error are both treated as failures here —
 * `deliveryPending`/`deliveryState: 'pending-delivery'` is NOT a failure (PHASE0_VERIFIED_API.md
 * #5): the spend is certified on-chain already, only mailbox delivery is deferred.
 */
async function sendOne(agent: AgentPort, params: { coinId: string; amount: bigint; to: string; memo?: string }, scope: string): Promise<SendOutcome> {
  try {
    const result = await agent.payments.send({ coinId: params.coinId, amount: params.amount.toString(), recipient: params.to, memo: params.memo });
    if (result.status === 'failed') {
      log.error(scope, `send to ${params.to} returned status=failed: ${result.error ?? '(no error message)'}`);
      return { ok: false, error: result.error ?? 'send returned status=failed' };
    }
    log.info(
      scope,
      `send to ${params.to}: status=${result.status} deliveryPending=${result.deliveryPending ?? false} amount=${params.amount} coinId=${params.coinId}`,
    );
    return { ok: true, result };
  } catch (err) {
    if (isSphereError(err)) {
      log.error(scope, `send to ${params.to} threw SphereError code=${err.code}: ${err.message}`);
      return { ok: false, error: `${err.code}: ${err.message}` };
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error(scope, `send to ${params.to} threw: ${message}`);
    return { ok: false, error: message };
  }
}

async function executeForward(action: ForwardAction, agent: AgentPort, transfer: IncomingTransfer | undefined, scope: string): Promise<ExecutionOutcome> {
  const received = receivedAmountForCoin(transfer, action.coinId);
  const amount = computeAmount(action, received);
  if (amount <= 0n) return { success: false, detail: `computed forward amount is ${amount} — skipping send` };

  const outcome = await sendOne(agent, { coinId: action.coinId, amount, to: action.to, memo: action.memo }, scope);
  if (!outcome.ok) return { success: false, detail: outcome.error };
  return { success: true, detail: `forwarded ${amount} to ${action.to}`, transferResults: [outcome.result] };
}

/**
 * Sequential sends, one per split recipient, checkpointed per-leg (SPLIT_DESIGN_V2.md) so a
 * retry of the SAME (ruleId, transfer.id) — e.g. after a crash mid-processing causes the
 * delivery port to redeliver the event — never resends a leg that already landed, and never
 * guesses at a leg whose outcome is unknown (stuck at 'sending').
 *
 * Checkpointing needs a stable executionKey; only onIncoming triggers have one (transfer.id).
 * Balance-triggered splits (no `transfer`) run unprotected — flagged loudly, not silently.
 */
async function executeSplit(
  action: SplitAction,
  agent: AgentPort,
  transfer: IncomingTransfer | undefined,
  scope: string,
  ruleId: string,
  progress: SplitProgressPort,
): Promise<ExecutionOutcome> {
  const received = receivedAmountForCoin(transfer, action.coinId);
  const executionKey = transfer?.id;
  if (!executionKey) {
    log.warn(scope, 'split action has no transfer.id (balance-triggered) — per-leg checkpoint is NOT available for this run, see SPLIT_DESIGN_V2.md §7');
  }

  const results: TransferResult[] = [];

  for (let i = 0; i < action.splits.length; i++) {
    const split = action.splits[i];
    if (!split) continue;
    const amount = (received * BigInt(split.percent)) / 100n;
    if (amount <= 0n) continue;

    const existing = executionKey ? progress.getLeg(ruleId, executionKey, i) : undefined;

    if (existing?.status === 'sent') {
      log.info(scope, `split leg ${i} to ${split.to} already sent previously (transferId=${existing.transferId}) — SKIPPING`);
      continue;
    }

    if (existing?.status === 'sending') {
      const detail =
        `split leg ${i} to ${split.to} (amount ${existing.amount}) is stuck at 'sending' since ${new Date(existing.startedAt).toISOString()} — ` +
        `outcome UNKNOWN (no transferId was ever recorded, since send() never resolved). Check the agent's and ${split.to}'s balance, or the ` +
        `Network Explorer, before touching this rule again.`;
      log.error(scope, `MANUAL REVIEW NEEDED: ${detail}`);
      return { success: false, needsManualReview: true, detail, transferResults: results };
    }

    // existing === undefined -> never attempted. Checkpoint MUST flush before send() starts.
    if (executionKey) {
      await progress.markLegSending(ruleId, executionKey, i, { to: split.to, amount: amount.toString() });
    }

    const outcome = await sendOne(agent, { coinId: action.coinId, amount, to: split.to }, scope);
    if (!outcome.ok) {
      if (executionKey) {
        // send() gave a DEFINITIVE answer (resolved failed, or threw) — not the ambiguous
        // crash-mid-flight case. Clear the 'sending' marker so a retry treats this leg as
        // never-attempted instead of misreading it as stuck.
        await progress.clearLeg(ruleId, executionKey, i);
      }
      return { success: false, detail: `split leg ${i} to ${split.to} failed after ${results.length} prior send(s): ${outcome.error}`, transferResults: results };
    }
    results.push(outcome.result);

    if (executionKey) {
      await progress.markLegSent(ruleId, executionKey, i, outcome.result.id);
    }
  }

  return { success: true, detail: `split sent to ${results.length} recipient(s)`, transferResults: results };
}

async function executeNotify(action: { to: string; message: string }, agent: AgentPort, scope: string): Promise<ExecutionOutcome> {
  try {
    await agent.communications.sendDM(action.to, action.message);
    return { success: true, detail: `notified ${action.to}` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error(scope, `notify to ${action.to} failed: ${detail}`);
    return { success: false, detail: `notify failed: ${detail}` };
  }
}

/** Action Executor (CLAUDE.md 4.6). `transfer` is undefined for balance-triggered rules. */
export async function executeAction(
  rule: Rule,
  agent: AgentPort,
  transfer: IncomingTransfer | undefined,
  scope: string,
  progress: SplitProgressPort = NOOP_PROGRESS,
): Promise<ExecutionOutcome> {
  switch (rule.action.type) {
    case 'forward':
      return executeForward(rule.action, agent, transfer, scope);
    case 'split':
      return executeSplit(rule.action, agent, transfer, scope, rule.id, progress);
    case 'notify':
      return executeNotify(rule.action, agent, scope);
  }
}
