import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { operations } from '../dist/tools.js';
import { workflowText } from '../dist/workflows.js';

const op = name => {
  const found = operations.find(operation => operation.name === 'reliquary_' + name);
  assert.ok(found, name);
  return found;
};
const key = 'stable_request_key_123456';
const profile = { id: 'fixture', version: '1', digest: 'a'.repeat(64), modelId: 'fixture-model', modelName: 'Fixture model',
  modelRevision: 'b'.repeat(40), environmentId: 'fixture-env', environmentName: 'Fixture environment', environmentVersion: '1',
  environmentDigest: 'c'.repeat(64), description: 'Contract fixture', example: 'One plus one?', evaluation: 'Held-out answer',
  imageDigest: 'sha256:' + 'd'.repeat(64), method: 'sft', datasetFormat: 'instruction', offerId: 'fixture-offer', accelerator: 'CPU',
  gpuCount: 0, maxSteps: 100, maxHours: 2, conformanceDigest: 'e'.repeat(64) };

test('registry schemas are strict, convertible and named uniquely', () => {
  assert.equal(new Set(operations.map(o => o.name)).size, operations.length);
  for (const operation of operations) {
    assert.equal(operation.schema.type, 'object');
    assert.ok(z.toJSONSchema(operation.schema));
    assert.equal(operation.schema.safeParse({ unexpected: true }).success, false);
  }
});

test('spending and destructive operations require explicit approval', () => {
  const examples = {
    generation_order: { quote_id: 'quote-1', idempotencyKey: key }, evaluation_order: { quote_id: 'quote-1', idempotencyKey: key },
    training_start: { draftId: 'draft-1', datasetId: 'file-1', revision: 1, idempotencyKey: key },
    resource_archive: { id: 'draft-1', revision: 1 }, generation_cancel: { id: 'order-1' }, evaluation_cancel: { id: 'eval-1' },
    training_cancel: { id: 'task-1' }, training_file_archive: { id: 'file-1' },
  };
  for (const operation of operations.filter(o => o.spend || o.destructive)) {
    const input = examples[operation.name.replace('reliquary_', '')];
    assert.ok(input, operation.name);
    assert.throws(() => operation.build(input));
    assert.throws(() => operation.build({ ...input, approveExecution: false }));
    assert.ok(operation.build({ ...input, approveExecution: true }));
  }
});

test('launches preserve stable keys and send only the exact approved payload', () => {
  for (const name of ['generation_order', 'evaluation_order']) {
    const operation = op(name);
    const input = { quote_id: 'quote-1', idempotencyKey: key, approveExecution: true };
    const request = operation.build(input);
    assert.equal(request.method, 'POST');
    assert.deepEqual(request.headers, { 'Idempotency-Key': key });
    assert.deepEqual(request.json, { quote_id: 'quote-1' });
    assert.deepEqual(operation.build(input), request);
    assert.throws(() => operation.build({ ...input, idempotencyKey: undefined }));
    assert.throws(() => operation.build({ ...input, idempotencyKey: 'short' }));
  }
  const input = { draftId: 'draft-1', datasetId: 'file-1', revision: 3, quoteId: 'quote-1', approveExecution: true, idempotencyKey: key };
  assert.deepEqual(op('training_start').build(input), { method: 'POST', path: '/api/v1/training/tasks', scope: 'training',
    headers: { 'Idempotency-Key': key }, json: { draftId: 'draft-1', datasetId: 'file-1', revision: 3, quoteId: 'quote-1', approveExecution: true } });
  assert.throws(() => op('training_start').build({ ...input, revision: 0 }));
  assert.throws(() => op('training_start').build({ ...input, idempotencyKey: 'short' }));
});

test('draft edits use PATCH with an explicit current revision', () => {
  const input = { id: 'draft-1', kind: 'training', name: 'Training', config: { schemaVersion: 2, compute: { maxHours: 1 } }, revision: 3 };
  assert.deepEqual(op('resource_update').build(input), { method: 'PATCH', path: '/api/resources/draft-1', scope: 'resources',
    headers: { 'X-Resource-Revision': '3' }, json: { kind: 'training', name: 'Training', config: input.config } });
  for (const revision of [undefined, 0, 1.5]) assert.throws(() => op('resource_update').build({ ...input, revision }));
  assert.throws(() => op('resource_get').build({ id: '../private' }));
  assert.throws(() => op('resource_create').build({ kind: 'training', name: 'Training', config: { value: 'x'.repeat(24_000) }, idempotencyKey: key }));
});

test('qualified training draft maps only the verified profile identities and allocation', () => {
  const input = { name: 'Training', objective: 'Improve response quality', profile, datasetId: 'file-1', budgetUsd: 10, idempotencyKey: key };
  const request = op('training_draft_create').build(input);
  assert.equal(request.scope, 'resources');
  assert.equal(request.method, 'POST');
  assert.deepEqual(request.headers, { 'Idempotency-Key': key });
  assert.deepEqual(request.json, { kind: 'training', name: 'Training', config: { schemaVersion: 2, profileDigest: profile.digest,
    objective: input.objective, environment: { id: profile.environmentId, version: profile.environmentVersion }, model: { id: profile.modelId },
    dataset: { id: 'file-1' }, optimization: { method: 'sft', maxSteps: 50 },
    compute: { offerId: profile.offerId, gpuCount: 0, maxHours: 1, providerPolicy: 'private' }, budget: { currency: 'USD', ceiling: 10 } } });
  assert.throws(() => op('training_draft_create').build({ ...input, maxSteps: 101 }));
  assert.throws(() => op('training_draft_create').build({ ...input, maxHours: 3 }));
  assert.throws(() => op('training_draft_create').build({ ...input, profile: { ...profile, gpuCount: 1 } }));
  assert.throws(() => op('training_draft_create').build({ ...input, profile: { ...profile, unexpected: true } }));
});

test('quotes preserve reviewed inputs and backend sampling limits', () => {
  const input = { model: 'org/model', revision: 'a'.repeat(40), envs: [{ env: 'math', set_id: 'set-1', problems: 10, samples: 2 }],
    max_new_tokens: 1024, thinking: false, mode: 'subnet', sampling: { temperature: 0.6, top_p: 0.95, top_k: -1, seed: 3 } };
  assert.deepEqual(op('evaluation_quote').build(input), { method: 'POST', path: '/api/v1/evaluations/quotes', scope: 'evaluations', json: input });
  assert.throws(() => op('evaluation_quote').build({ ...input, sampling: { temperature: 2.1 } }));
  assert.throws(() => op('evaluation_quote').build({ ...input, revision: 'main' }));
  const generation = op('generation_pinned_quote');
  const pinned = { model: input.model, revision: input.revision, env: 'math', prompt_count: 10,
    samples_per_prompt: 2, max_new_tokens: 1024, thinking: false, sampling: { temperature: 0 } };
  assert.deepEqual({
    exclusiveMinimum: z.toJSONSchema(generation.schema).properties.sampling.properties.temperature.exclusiveMinimum,
    generationAcceptsZero: generation.schema.safeParse(pinned).success,
    evaluationAcceptsZero: op('evaluation_quote').schema.safeParse({ ...input, sampling: { temperature: 0 } }).success,
  }, { exclusiveMinimum: 0, generationAcceptsZero: false, evaluationAcceptsZero: true });
  const quote = { draftId: 'draft-1', datasetId: 'file-1', revision: 2 };
  assert.deepEqual(op('training_quote').build(quote), { method: 'POST', path: '/api/v1/training/quotes', scope: 'training', json: quote });
});

test('downloads bound byte ranges and reject path traversal', () => {
  for (const name of ['evaluation_download', 'training_file_download']) {
    const input = name === 'evaluation_download' ? { id: 'eval-1', fileName: 'report.json' } : { id: 'file-1' };
    assert.deepEqual(op(name).build(input).headers, { Range: 'bytes=0-262143' });
    assert.deepEqual(op(name).build({ ...input, offset: 100, maxBytes: 25 }).headers, { Range: 'bytes=100-124' });
    assert.throws(() => op(name).build({ ...input, maxBytes: 262_145 }));
    assert.throws(() => op(name).build({ ...input, offset: -1 }));
    assert.throws(() => op(name).build({ ...input, offset: Number.MAX_SAFE_INTEGER }));
    assert.throws(() => op(name).build({ ...input, id: '../private' }));
  }
  assert.throws(() => op('evaluation_download').build({ id: 'eval-1', fileName: '..' }));
  assert.throws(() => op('evaluation_download').build({ id: 'eval-1', fileName: 'dir/report.json' }));
});

test('monitoring accepts only published views and filters', () => {
  assert.equal(op('monitoring_history').build({ view: 'network', range: '7d' }).path, '/api/monitoring/history/network?range=7d');
  assert.throws(() => op('monitoring_history').build({ view: 'training', range: '7d' }));
  assert.throws(() => op('monitoring_analytics').build({ view: 'network', windows: '500' }));
  assert.throws(() => op('monitoring_analytics').build({ view: 'network', offset: 61 }));
  assert.throws(() => op('monitoring_analytics').build({ view: '../private' }));
  assert.throws(() => op('training_upload').build({ name: 'data.jsonl', format: 'instruction', jsonl: '{}', rightsConfirmed: false }));
  assert.match(workflowText, /reliquary_training_draft_create/);
});
