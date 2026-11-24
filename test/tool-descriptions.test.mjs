import test from 'node:test';
import assert from 'node:assert/strict';
import { operations } from '../dist/tools.js';

const op = name => operations.find(value => value.name === 'reliquary_' + name);

test('readiness says its execution and billing fields concern private training runs only', () => {
  // GET /api/ready returns { ready, execution, billing }; execution and billing are computed from the training
  // dispatch switch, training billing and approved training profiles, never from Batch or evaluation ordering.
  const { description } = op('readiness');
  assert.match(description, /private training runs only/);
  for (const field of ['ready', 'execution', 'billing', 'service-credits', 'operator-funded-pilot', 'unavailable'])
    assert.ok(description.includes(field), field);
  assert.match(description, /any_model_ordering in reliquary_generation_catalog for Batch/);
  assert.match(description, /ordering in reliquary_evaluation_catalog for evaluations/);
  assert.ok(!description.includes('upstream billing'));
  assert.ok(op('generation_catalog') && op('evaluation_catalog'));
});
