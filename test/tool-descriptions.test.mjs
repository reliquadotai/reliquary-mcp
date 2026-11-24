import test from 'node:test';
import assert from 'node:assert/strict';
import { operations } from '../dist/tools.js';
import { workflowText } from '../dist/workflows.js';

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

test('the batch file record does not promise a sha256 as soon as the file is processed', () => {
  // The platform hashes a file uploaded in parts when a quote first reads it: a processed file answers sha256 null before.
  const { description } = op('batch_file_get');
  assert.match(description, /sha256 null until a quote \(reliquary_batch_quote\) has read it/);
  assert.match(description, /refused as invalid_batch_file keeps null/);
  assert.ok(!description.includes('once processed'));
  assert.match(description, /Never returns its contents/);
});

test('the workflow text gives the size limit of the OpenAI SDK upload route', () => {
  // POST /api/openai/v1/files holds the file in memory and stops at 32 MiB; the native upload in parts goes further.
  const sentence = workflowText.split('. ').find(part => part.includes('https://app.reliqua.ai/api/openai/v1'));
  assert.match(sentence, /only when it holds at most 32 MiB/);
  assert.match(sentence, /refuses a larger one/);
  assert.ok(!workflowText.includes('The same file can be sent with the official OpenAI SDK at base_url https://app.reliqua.ai/api/openai/v1;'));
  assert.match(workflowText, /These tools use the native routes, which upload in parts and quote before ordering\./);
});
