import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { executeAction } from '../src/rules/executor.js';
import { SplitProgressLog } from '../src/rules/split-progress.js';
import { createFakeAgent, fakeRule, fakeToken, fakeTransfer } from './test-helpers.js';

const COIN = 'coin-abc';

async function tempSplitProgressPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cpa-split-progress-test-'));
  return join(dir, 'split-progress.json');
}

test('split checkpoint: no record for any leg -> sends every leg and checkpoints each as sent', async () => {
  const progress = await SplitProgressLog.load(await tempSplitProgressPath());
  const { agent, sendCalls } = createFakeAgent();
  const rule = fakeRule({
    enabled: true,
    trigger: { type: 'onIncoming' },
    action: {
      type: 'split',
      coinId: COIN,
      splits: [
        { to: '@a', percent: 50 },
        { to: '@b', percent: 50 },
      ],
    },
    guards: {},
  });
  const transfer = fakeTransfer({ id: 'v2_tx1', tokens: [fakeToken(COIN, 'UCT', '100')] });

  const outcome = await executeAction(rule, agent, transfer, 'test', progress);

  assert.equal(outcome.success, true);
  assert.equal(sendCalls.length, 2);
  assert.equal(progress.getLeg(rule.id, 'v2_tx1', 0)?.status, 'sent');
  assert.equal(progress.getLeg(rule.id, 'v2_tx1', 1)?.status, 'sent');
});

test('split checkpoint: a leg already marked sent is skipped on retry, never resent', async () => {
  const progress = await SplitProgressLog.load(await tempSplitProgressPath());
  const rule = fakeRule({
    enabled: true,
    trigger: { type: 'onIncoming' },
    action: {
      type: 'split',
      coinId: COIN,
      splits: [
        { to: '@a', percent: 50 },
        { to: '@b', percent: 50 },
      ],
    },
    guards: {},
  });
  const transfer = fakeTransfer({ id: 'v2_tx2', tokens: [fakeToken(COIN, 'UCT', '100')] });

  // Pre-seed leg 0 as already sent in a prior (simulated) attempt.
  await progress.markLegSending(rule.id, transfer.id, 0, { to: '@a', amount: '50' });
  await progress.markLegSent(rule.id, transfer.id, 0, 'prior-tx-id');

  const { agent, sendCalls } = createFakeAgent();
  const outcome = await executeAction(rule, agent, transfer, 'test', progress);

  assert.equal(outcome.success, true);
  assert.equal(sendCalls.length, 1, 'only the not-yet-sent leg (@b) should be attempted');
  assert.equal(sendCalls[0]?.recipient, '@b');
});

test('split checkpoint: a leg stuck at sending stops the rule immediately without guessing, and never touches later legs', async () => {
  const progress = await SplitProgressLog.load(await tempSplitProgressPath());
  const rule = fakeRule({
    enabled: true,
    trigger: { type: 'onIncoming' },
    action: {
      type: 'split',
      coinId: COIN,
      splits: [
        { to: '@a', percent: 33 },
        { to: '@b', percent: 33 },
        { to: '@c', percent: 34 },
      ],
    },
    guards: {},
  });
  const transfer = fakeTransfer({ id: 'v2_tx3', tokens: [fakeToken(COIN, 'UCT', '100')] });

  // Simulate a crash right after leg 0's 'sending' checkpoint flushed but before send() resolved.
  await progress.markLegSending(rule.id, transfer.id, 0, { to: '@a', amount: '33' });

  const { agent, sendCalls } = createFakeAgent();
  const outcome = await executeAction(rule, agent, transfer, 'test', progress);

  assert.equal(outcome.success, false);
  assert.equal(outcome.needsManualReview, true);
  assert.equal(sendCalls.length, 0, 'the stuck leg must not be auto-resent, and no later leg may be attempted either');
  assert.equal(progress.getLeg(rule.id, transfer.id, 1), undefined, 'leg 1 must never get a checkpoint — the loop must stop AT the ambiguous leg');
  assert.equal(progress.getLeg(rule.id, transfer.id, 2), undefined, 'leg 2 must never get a checkpoint either');
});

test('split checkpoint: retry after a genuine (non-crash) send failure resumes without resending the already-sent leg', async () => {
  const progress = await SplitProgressLog.load(await tempSplitProgressPath());
  const rule = fakeRule({
    enabled: true,
    trigger: { type: 'onIncoming' },
    action: {
      type: 'split',
      coinId: COIN,
      splits: [
        { to: '@a', percent: 33 },
        { to: '@b', percent: 33 },
        { to: '@c', percent: 34 },
      ],
    },
    guards: {},
  });
  const transfer = fakeTransfer({ id: 'v2_tx4', tokens: [fakeToken(COIN, 'UCT', '100')] });

  // First attempt: leg @b fails cleanly (send() resolves with status:'failed' — not a crash).
  let call = 0;
  const first = createFakeAgent({
    sendResult: () => {
      call += 1;
      if (call === 2) return { id: 'x', status: 'failed', error: 'network blip', tokens: [], tokenTransfers: [] };
      return { id: `ok-${call}`, status: 'completed', tokens: [], tokenTransfers: [] };
    },
  });
  const outcome1 = await executeAction(rule, first.agent, transfer, 'test', progress);
  assert.equal(outcome1.success, false);
  assert.equal(first.sendCalls.length, 2, '@a sent, @b attempted and failed, @c never reached');
  assert.equal(progress.getLeg(rule.id, transfer.id, 0)?.status, 'sent');
  assert.equal(
    progress.getLeg(rule.id, transfer.id, 1),
    undefined,
    "a leg that failed CLEANLY (send() resolved, told us definitively) must not leave a 'sending' marker — that would make a normal retriable failure look like an unresolved crash",
  );

  // Retry: no more forced failure this time.
  const second = createFakeAgent();
  const outcome2 = await executeAction(rule, second.agent, transfer, 'test', progress);

  assert.equal(outcome2.success, true);
  assert.equal(second.sendCalls.length, 2, 'only @b and @c should be (re)sent — @a must be skipped');
  assert.deepEqual(
    second.sendCalls.map((c) => c.recipient),
    ['@b', '@c'],
  );
});
