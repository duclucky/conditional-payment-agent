import type { Asset, TransferResult } from '@unicitylabs/sphere-sdk';

export interface OnIncomingTrigger {
  readonly type: 'onIncoming';
  readonly fromSender?: string;
  /** Base units, string. Matches if ANY single received coin's total meets this — never sums across coins. */
  readonly minIncoming?: string;
}

export interface OnBalanceTrigger {
  readonly type: 'onBalanceAbove' | 'onBalanceBelow';
  readonly threshold: string;
  readonly coinId: string;
}

export interface OnScheduleTrigger {
  readonly type: 'onSchedule';
  readonly cron: string;
}

export type RuleTrigger = OnIncomingTrigger | OnBalanceTrigger | OnScheduleTrigger;

export interface ForwardAction {
  readonly type: 'forward';
  readonly to: string;
  readonly percent?: number;
  readonly fixedAmount?: string;
  readonly coinId: string;
  readonly memo?: string;
}

export interface SplitAction {
  readonly type: 'split';
  readonly splits: ReadonlyArray<{ readonly to: string; readonly percent: number }>;
  readonly coinId: string;
}

export interface NotifyAction {
  readonly type: 'notify';
  readonly to: string;
  readonly message: string;
}

export type RuleAction = ForwardAction | SplitAction | NotifyAction;

export interface RuleGuards {
  readonly minAmount?: string;
  readonly maxTriggersPerHour?: number;
  readonly excludeSenders?: readonly string[];
  readonly cooldownSeconds?: number;
}

export interface RuleState {
  lastFiredAt?: number;
  fireCount: number;
  /** Fixed-window rate-limit counters backing maxTriggersPerHour (not in the original CLAUDE.md
   * sketch — added because enforcing a rolling "N per hour" guard needs some window state). */
  windowStartedAt?: number;
  firesInWindow?: number;
}

export interface Rule {
  readonly id: string;
  enabled: boolean;
  readonly trigger: RuleTrigger;
  readonly action: RuleAction;
  readonly guards: RuleGuards;
  state: RuleState;
}

/** What Guard Check / Rule Matcher need to turn a nametag into a comparable identity. */
export interface IdentityResolverPort {
  resolveChainPubkey(identifier: string): Promise<string | null>;
}

/** The narrow slice of Sphere the Action Executor depends on — real Sphere satisfies this
 * structurally, and tests can pass a plain object instead of constructing a real wallet. */
export interface PaymentsPort {
  send(request: { coinId: string; amount: string; recipient: string; memo?: string }): Promise<TransferResult>;
  getBalance(coinId?: string): Asset[];
}

export interface CommunicationsPort {
  sendDM(recipient: string, content: string): Promise<unknown>;
}

export interface AgentPort {
  readonly identity: { chainPubkey?: string } | null | undefined;
  readonly payments: PaymentsPort;
  readonly communications: CommunicationsPort;
}

/**
 * Per-leg checkpoint for `split` actions (SPLIT_DESIGN_V2.md). Two phases bracket the send:
 * 'sending' is written and flushed BEFORE the send() call, 'sent' after it resolves. A leg
 * stuck at 'sending' means the process died mid-flight — genuinely unknown outcome, never
 * guessed at (see SplitProgressPort).
 */
export interface SplitLegRecord {
  readonly status: 'sending' | 'sent';
  readonly to: string;
  readonly amount: string;
  readonly transferId?: string;
  readonly startedAt: number;
  readonly completedAt?: number;
}

export interface SplitProgressPort {
  /** Synchronous — reads already-loaded in-memory data, same as RuleStore.get()/IdempotencyLog.isProcessed(). */
  getLeg(ruleId: string, executionKey: string, legIndex: number): SplitLegRecord | undefined;
  /** MUST resolve before the corresponding send() call starts. */
  markLegSending(ruleId: string, executionKey: string, legIndex: number, info: { to: string; amount: string }): Promise<void>;
  markLegSent(ruleId: string, executionKey: string, legIndex: number, transferId: string): Promise<void>;
  /**
   * Revert a leg to "never attempted". Used when send() returns a DEFINITIVE failure (resolved
   * status:'failed', or threw) — that is NOT the ambiguous crash-mid-flight case: we know for
   * certain this attempt didn't land, so a retry should try it fresh rather than reading the
   * leftover 'sending' marker as an unresolved crash.
   */
  clearLeg(ruleId: string, executionKey: string, legIndex: number): Promise<void>;
}
