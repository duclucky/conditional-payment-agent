import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeAction } from '../src/rules/executor.js';
import { createFakeAgent, fakeRule, fakeToken, fakeTransfer } from './test-helpers.js';

const COIN = 'coin-abc';

test('forward: percent computes via BigInt floor division, never manufactures value', async () => {
  const { agent, sendCalls } = createFakeAgent();
  const rule = fakeRule({
    enabled: true,
    trigger: { type: 'onIncoming' },
    action: { type: 'forward', to: '@dest', percent: 10, coinId: COIN },
    guards: {},
  });
  const transfer = fakeTransfer({ tokens: [fakeToken(COIN, 'UCT', '1000000000000000000')] }); // 1.0 UCT @ 18 decimals

  const outcome = await executeAction(rule, agent, transfer, 'test');

  assert.equal(outcome.success, true);
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0]?.amount, '100000000000000000'); // exactly 10%, no drift
});

test('forward: percent floors on non-exact division instead of rounding up', async () => {
  const { agent, sendCalls } = createFakeAgent();
  const rule = fakeRule({
    enabled: true,
    trigger: { type: 'onIncoming' },
    action: { type: 'forward', to: '@dest', percent: 33, coinId: COIN },
    guards: {},
  });
  // 10 base units * 33% = 3.3 -> must floor to 3, never round to 4 (would manufacture value).
  const transfer = fakeTransfer({ tokens: [fakeToken(COIN, 'UCT', '10')] });

  await executeAction(rule, agent, transfer, 'test');

  assert.equal(sendCalls[0]?.amount, '3');
});

test('forward: fixedAmount is sent as-is, ignoring the received amount', async () => {
  const { agent, sendCalls } = createFakeAgent();
  const rule = fakeRule({
    enabled: true,
    trigger: { type: 'onIncoming' },
    action: { type: 'forward', to: '@dest', fixedAmount: '42', coinId: COIN },
    guards: {},
  });
  const transfer = fakeTransfer({ tokens: [fakeToken(COIN, 'UCT', '999999999999999999999')] });

  await executeAction(rule, agent, transfer, 'test');

  assert.equal(sendCalls[0]?.amount, '42');
});

test('split: each recipient computed independently via floor division; sum can be <= total, never >', async () => {
  const { agent, sendCalls } = createFakeAgent();
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
  const transfer = fakeTransfer({ tokens: [fakeToken(COIN, 'UCT', '100')] });

  const outcome = await executeAction(rule, agent, transfer, 'test');

  assert.equal(outcome.success, true);
  const amounts = sendCalls.map((c) => BigInt(c.amount));
  assert.deepEqual(
    amounts.map(String),
    ['33', '33', '34'],
  );
  const total = amounts.reduce((sum, a) => sum + a, 0n);
  assert.ok(total <= 100n, `split sum ${total} must never exceed the received amount`);
});

test('split: stops and reports failure on the first send failure, without retrying prior sends', async () => {
  let calls = 0;
  const { agent, sendCalls } = createFakeAgent({
    sendResult: () => {
      calls += 1;
      if (calls === 2) return { id: 'x', status: 'failed', error: 'insufficient balance', tokens: [], tokenTransfers: [] };
      return { id: `ok-${calls}`, status: 'completed', tokens: [], tokenTransfers: [] };
    },
  });
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
  const transfer = fakeTransfer({ tokens: [fakeToken(COIN, 'UCT', '100')] });

  const outcome = await executeAction(rule, agent, transfer, 'test');

  assert.equal(outcome.success, false);
  assert.equal(sendCalls.length, 2); // attempted both; second failed
  assert.match(outcome.detail, /after 1 prior send/);
});

test('forward: a thrown SphereError-like error is treated as failure, not swallowed', async () => {
  const { agent } = createFakeAgent({ sendError: Object.assign(new Error('nope'), { code: 'INSUFFICIENT_BALANCE' }) });
  const rule = fakeRule({
    enabled: true,
    trigger: { type: 'onIncoming' },
    action: { type: 'forward', to: '@dest', percent: 100, coinId: COIN },
    guards: {},
  });
  const transfer = fakeTransfer({ tokens: [fakeToken(COIN, 'UCT', '10')] });

  const outcome = await executeAction(rule, agent, transfer, 'test');

  assert.equal(outcome.success, false);
});
