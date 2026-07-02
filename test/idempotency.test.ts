import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { IdempotencyLog } from '../src/rules/idempotency.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'cpa-idempotency-test-'));
}

test('tryClaim: concurrent claims for the SAME transferId — exactly one wins', async () => {
  const idempotency = new IdempotencyLog(await tempDir());

  const results = await Promise.all([
    idempotency.tryClaim('v2_same'),
    idempotency.tryClaim('v2_same'),
    idempotency.tryClaim('v2_same'),
    idempotency.tryClaim('v2_same'),
    idempotency.tryClaim('v2_same'),
  ]);

  assert.equal(results.filter(Boolean).length, 1, 'exactly one concurrent claim attempt for the same transferId must win');
});

test('tryClaim: different transferIds all succeed independently', async () => {
  const idempotency = new IdempotencyLog(await tempDir());

  const results = await Promise.all([idempotency.tryClaim('v2_a'), idempotency.tryClaim('v2_b'), idempotency.tryClaim('v2_c')]);

  assert.deepEqual(results, [true, true, true]);
});

test('tryClaim: a second attempt for an already-claimed transferId (sequential) returns false', async () => {
  const idempotency = new IdempotencyLog(await tempDir());

  assert.equal(await idempotency.tryClaim('v2_x'), true);
  assert.equal(await idempotency.tryClaim('v2_x'), false);
});

test('isProcessed: reflects claims made via tryClaim, false for never-claimed ids', async () => {
  const idempotency = new IdempotencyLog(await tempDir());

  assert.equal(idempotency.isProcessed('v2_unclaimed'), false);
  await idempotency.tryClaim('v2_claimed');
  assert.equal(idempotency.isProcessed('v2_claimed'), true);
});
