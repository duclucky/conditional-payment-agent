import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkGuards } from '../src/rules/guards.js';
import { fakeResolver, fakeRule, fakeToken, fakeTransfer } from './test-helpers.js';

const COIN = 'coin-abc';
const AGENT_PUBKEY = 'agent-chain-pubkey';

test('loop protection: rejects when the sender IS the agent itself', async () => {
  const rule = fakeRule({
    enabled: true,
    trigger: { type: 'onIncoming' },
    action: { type: 'forward', to: '@dest', percent: 10, coinId: COIN },
    guards: {},
  });
  const transfer = fakeTransfer({ senderPubkey: AGENT_PUBKEY, tokens: [fakeToken(COIN, 'UCT', '1')] });

  const result = await checkGuards(rule, {
    resolver: fakeResolver({}),
    agentChainPubkey: AGENT_PUBKEY,
    allRuleDestinations: [],
    transfer,
    now: 0,
  });

  assert.equal(result.allowed, false);
  assert.match(result.reason ?? '', /agent itself/);
});

test('loop protection: rejects when the sender resolves to a rule destination (any rule, not just this one)', async () => {
  const rule = fakeRule({
    enabled: true,
    trigger: { type: 'onIncoming' },
    action: { type: 'forward', to: '@dest', percent: 10, coinId: COIN },
    guards: {},
  });
  const destinationPubkey = 'dest-chain-pubkey';
  const transfer = fakeTransfer({ senderPubkey: destinationPubkey, tokens: [fakeToken(COIN, 'UCT', '1')] });

  const result = await checkGuards(rule, {
    resolver: fakeResolver({ '@some-other-rules-destination': destinationPubkey }),
    agentChainPubkey: AGENT_PUBKEY,
    allRuleDestinations: ['@some-other-rules-destination'],
    transfer,
    now: 0,
  });

  assert.equal(result.allowed, false);
  assert.match(result.reason ?? '', /protected identity/);
});

test('loop protection: rejects when the sender is in guards.excludeSenders', async () => {
  const rule = fakeRule({
    enabled: true,
    trigger: { type: 'onIncoming' },
    action: { type: 'forward', to: '@dest', percent: 10, coinId: COIN },
    guards: { excludeSenders: ['@blocked'] },
  });
  const blockedPubkey = 'blocked-chain-pubkey';
  const transfer = fakeTransfer({ senderPubkey: blockedPubkey, tokens: [fakeToken(COIN, 'UCT', '1')] });

  const result = await checkGuards(rule, {
    resolver: fakeResolver({ '@blocked': blockedPubkey }),
    agentChainPubkey: AGENT_PUBKEY,
    allRuleDestinations: [],
    transfer,
    now: 0,
  });

  assert.equal(result.allowed, false);
});

test('allows a legitimate sender that is neither the agent nor any protected destination', async () => {
  const rule = fakeRule({
    enabled: true,
    trigger: { type: 'onIncoming' },
    action: { type: 'forward', to: '@dest', percent: 10, coinId: COIN },
    guards: {},
  });
  const transfer = fakeTransfer({ senderPubkey: 'legit-sender-pubkey', tokens: [fakeToken(COIN, 'UCT', '1')] });

  const result = await checkGuards(rule, {
    resolver: fakeResolver({ '@dest': 'dest-chain-pubkey' }),
    agentChainPubkey: AGENT_PUBKEY,
    allRuleDestinations: ['@dest'],
    transfer,
    now: 0,
  });

  assert.equal(result.allowed, true);
});

test('cooldownSeconds: rejects while within the cooldown window', async () => {
  const rule = fakeRule(
    {
      enabled: true,
      trigger: { type: 'onIncoming' },
      action: { type: 'notify', to: '@dest', message: 'hi' },
      guards: { cooldownSeconds: 60 },
    },
    { lastFiredAt: 1_000_000 },
  );

  const result = await checkGuards(rule, {
    resolver: fakeResolver({}),
    agentChainPubkey: AGENT_PUBKEY,
    allRuleDestinations: [],
    now: 1_000_000 + 30_000, // 30s later, cooldown is 60s
  });

  assert.equal(result.allowed, false);
  assert.match(result.reason ?? '', /cooldown/);
});

test('maxTriggersPerHour: rejects once the fixed-window cap is reached, resets after the window', async () => {
  const rule = fakeRule(
    {
      enabled: true,
      trigger: { type: 'onIncoming' },
      action: { type: 'notify', to: '@dest', message: 'hi' },
      guards: { maxTriggersPerHour: 2 },
    },
    { windowStartedAt: 0, firesInWindow: 2 },
  );

  const withinWindow = await checkGuards(rule, {
    resolver: fakeResolver({}),
    agentChainPubkey: AGENT_PUBKEY,
    allRuleDestinations: [],
    now: 10_000, // still inside the 1h window
  });
  assert.equal(withinWindow.allowed, false);

  const afterWindow = await checkGuards(rule, {
    resolver: fakeResolver({}),
    agentChainPubkey: AGENT_PUBKEY,
    allRuleDestinations: [],
    now: 60 * 60 * 1000 + 1, // past the 1h window
  });
  assert.equal(afterWindow.allowed, true);
});

test('minAmount: rejects an incoming amount below the guard threshold', async () => {
  const rule = fakeRule({
    enabled: true,
    trigger: { type: 'onIncoming' },
    action: { type: 'forward', to: '@dest', percent: 10, coinId: COIN },
    guards: { minAmount: '100' },
  });
  const transfer = fakeTransfer({ senderPubkey: 'legit', tokens: [fakeToken(COIN, 'UCT', '50')] });

  const result = await checkGuards(rule, {
    resolver: fakeResolver({}),
    agentChainPubkey: AGENT_PUBKEY,
    allRuleDestinations: [],
    transfer,
    now: 0,
  });

  assert.equal(result.allowed, false);
  assert.match(result.reason ?? '', /minAmount/);
});
