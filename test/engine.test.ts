import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RuleEngine } from '../src/rules/engine.js';
import { IdempotencyLog } from '../src/rules/idempotency.js';
import { SplitProgressLog } from '../src/rules/split-progress.js';
import { RuleStore } from '../src/rules/store.js';
import type { AgentPort } from '../src/rules/types.js';
import { createFakeAgent, fakeResolver, fakeToken, fakeTransfer } from './test-helpers.js';

const COIN = 'coin-abc';

async function tempPaths(): Promise<{ rulesPath: string; idempotencyDir: string; splitProgressPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'cpa-engine-test-'));
  return { rulesPath: join(dir, 'rules.json'), idempotencyDir: join(dir, 'idempotency'), splitProgressPath: join(dir, 'split-progress.json') };
}

test('idempotency: the same transfer.id processed twice (same process) only pays once', async () => {
  const { rulesPath, idempotencyDir, splitProgressPath } = await tempPaths();
  const store = await RuleStore.load(rulesPath);
  await store.add({
    enabled: true,
    trigger: { type: 'onIncoming' },
    action: { type: 'forward', to: '@dest', percent: 10, coinId: COIN },
    guards: {},
  });
  const idempotency = new IdempotencyLog(idempotencyDir);
  const { agent, sendCalls } = createFakeAgent();
  const resolver = fakeResolver({ '@dest': 'dest-pubkey' });
  const engine = new RuleEngine(agent, store, idempotency, resolver, await SplitProgressLog.load(splitProgressPath));

  const transfer = fakeTransfer({ id: 'v2_same-event', senderPubkey: 'sender-pubkey', tokens: [fakeToken(COIN, 'UCT', '1000')] });

  await engine.handleIncomingTransfer(transfer);
  await engine.handleIncomingTransfer(transfer); // redelivery of the SAME event

  assert.equal(sendCalls.length, 1, 'the rule must fire exactly once despite the event being processed twice');
});

test('idempotency: survives a simulated restart (fresh IdempotencyLog instance loaded from the same directory)', async () => {
  const { rulesPath, idempotencyDir, splitProgressPath } = await tempPaths();
  await (await RuleStore.load(rulesPath)).add({
    enabled: true,
    trigger: { type: 'onIncoming' },
    action: { type: 'forward', to: '@dest', percent: 10, coinId: COIN },
    guards: {},
  });
  const transfer = fakeTransfer({ id: 'v2_restart-event', senderPubkey: 'sender-pubkey', tokens: [fakeToken(COIN, 'UCT', '1000')] });

  const { agent: agent1, sendCalls: sendCalls1 } = createFakeAgent();
  const engine1 = new RuleEngine(
    agent1,
    await RuleStore.load(rulesPath),
    new IdempotencyLog(idempotencyDir),
    fakeResolver({ '@dest': 'dest-pubkey' }),
    await SplitProgressLog.load(splitProgressPath),
  );
  await engine1.handleIncomingTransfer(transfer);
  assert.equal(sendCalls1.length, 1);

  // Simulated restart: brand new engine + fresh IdempotencyLog instance, pointed at the SAME
  // directory, same event redelivered (e.g. delivery-port replay after reconnect).
  const { agent: agent2, sendCalls: sendCalls2 } = createFakeAgent();
  const engine2 = new RuleEngine(
    agent2,
    await RuleStore.load(rulesPath),
    new IdempotencyLog(idempotencyDir),
    fakeResolver({ '@dest': 'dest-pubkey' }),
    await SplitProgressLog.load(splitProgressPath),
  );
  await engine2.handleIncomingTransfer(transfer);

  assert.equal(sendCalls2.length, 0, 'a redelivered event after a simulated restart must not be re-processed');
});

test('fail-safe: a failed send does not mark the rule as fired, but the event is still marked processed', async () => {
  const { rulesPath, idempotencyDir, splitProgressPath } = await tempPaths();
  const store = await RuleStore.load(rulesPath);
  const rule = await store.add({
    enabled: true,
    trigger: { type: 'onIncoming' },
    action: { type: 'forward', to: '@dest', percent: 10, coinId: COIN },
    guards: {},
  });
  const idempotency = new IdempotencyLog(idempotencyDir);
  const { agent } = createFakeAgent({
    sendResult: () => ({ id: 'x', status: 'failed', error: 'insufficient balance', tokens: [], tokenTransfers: [] }),
  });
  const engine = new RuleEngine(agent, store, idempotency, fakeResolver({ '@dest': 'dest-pubkey' }), await SplitProgressLog.load(splitProgressPath));

  const transfer = fakeTransfer({ id: 'v2_fail-event', senderPubkey: 'sender-pubkey', tokens: [fakeToken(COIN, 'UCT', '1000')] });
  await engine.handleIncomingTransfer(transfer);

  const stored = store.get(rule.id);
  assert.equal(stored?.state.fireCount, 0, 'fireCount must stay 0 — CLAUDE.md 4.4 #3: KHÔNG đánh dấu luật đã chạy on failure');
  assert.equal(stored?.state.lastFiredAt, undefined);
  // The EVENT itself is still fully evaluated (transport-level idempotency), even though the
  // RULE didn't fire (business-level state) — see engine.ts's doc comment for why these differ.
  assert.equal(idempotency.isProcessed('v2_fail-event'), true);
});

test('no rule matches: the event is still marked processed (an event with zero matches is still fully evaluated)', async () => {
  const { rulesPath, idempotencyDir, splitProgressPath } = await tempPaths();
  const store = await RuleStore.load(rulesPath); // no rules added
  const idempotency = new IdempotencyLog(idempotencyDir);
  const { agent, sendCalls } = createFakeAgent();
  const engine = new RuleEngine(agent, store, idempotency, fakeResolver({}), await SplitProgressLog.load(splitProgressPath));

  const transfer = fakeTransfer({ id: 'v2_no-match', senderPubkey: 'sender-pubkey', tokens: [fakeToken(COIN, 'UCT', '1000')] });
  await engine.handleIncomingTransfer(transfer);

  assert.equal(sendCalls.length, 0);
  assert.equal(idempotency.isProcessed('v2_no-match'), true);
});

test('runExclusive: two different events matching the same rate-limited rule are serialized, never interleaved', async () => {
  const { rulesPath, idempotencyDir, splitProgressPath } = await tempPaths();
  const store = await RuleStore.load(rulesPath);
  await store.add({
    enabled: true,
    trigger: { type: 'onIncoming' },
    action: { type: 'notify', to: '@dest', message: 'hi' },
    guards: { maxTriggersPerHour: 1 },
  });

  // The first event's notify call is deliberately slow — this widens the race window that
  // WOULD let a second, concurrently-arriving event's guard check read the same
  // not-yet-incremented rate-limit counter, if handling were not serialized.
  let dmCalls = 0;
  let firstCallStarted = false;
  const agent: AgentPort = {
    identity: { chainPubkey: 'agent-pubkey' },
    payments: { send: async () => ({ id: 'x', status: 'completed', tokens: [], tokenTransfers: [] }), getBalance: () => [] },
    communications: {
      sendDM: async () => {
        dmCalls += 1;
        if (!firstCallStarted) {
          firstCallStarted = true;
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        return {};
      },
    },
  };

  const engine = new RuleEngine(agent, store, new IdempotencyLog(idempotencyDir), fakeResolver({}), await SplitProgressLog.load(splitProgressPath));

  const t1 = fakeTransfer({ id: 'v2_evt1', senderPubkey: 's1', tokens: [fakeToken(COIN, 'UCT', '1')] });
  const t2 = fakeTransfer({ id: 'v2_evt2', senderPubkey: 's2', tokens: [fakeToken(COIN, 'UCT', '1')] });

  // Fire both WITHOUT awaiting the first before starting the second — this is the crux of the
  // test. Without runExclusive serializing them, event 2's guard check could run during event
  // 1's artificial delay and read the same firesInWindow=0, letting BOTH through despite the
  // configured maxTriggersPerHour: 1.
  const p1 = engine.handleIncomingTransfer(t1);
  const p2 = engine.handleIncomingTransfer(t2);
  await Promise.all([p1, p2]);

  assert.equal(dmCalls, 1, 'only one of the two concurrently-arriving events should have passed the rate limit — the other must see the post-increment counter');
  const rule = store.list()[0];
  assert.equal(rule?.state.fireCount, 1);
});
