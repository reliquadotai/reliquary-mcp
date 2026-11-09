import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { FILE_GRADERS, OFFICIAL_SKILLS, generationRequests, parseGenerationResponse } from '@reliquary/api';
import { ApiClient } from '../dist/api.js';
import { loadConfig } from '../dist/config.js';
import { buildServer, version } from '../dist/server.js';
import { operations } from '../dist/tools.js';
import { workflowText } from '../dist/workflows.js';

const op = name => operations.find(value => value.name === 'reliquary_' + name);
const token = 'rlq_' + '4'.repeat(48);
const REV = 'b968826d9c46dd6066d109eabc6255188de91218';
const FILE = 'file-10000000-0000-4000-8000-000000000003';
const ORDER = '10000000-0000-4000-8000-000000000004';
const config = loadConfig({ RELIQUARY_ORDERS_KEY: token, RELIQUARY_ENABLE_WRITES: 'true', RELIQUARY_EVALUATIONS_KEY: 'rlq_' + '5'.repeat(48) });
const sampling = { temperature: 0.6, top_p: 0.95, top_k: 20, max_tokens: 64, seed: 7, n: 1 };
// A file evaluation quote as worker/dataset-any.ts publicQuote returns it.
const evaluationQuote = {
  quote_id: '10000000-0000-4000-8000-000000000005', price_usd: 2.925146, est_price_usd: 2.92508, est_tokens: 64, max_tokens: 128,
  eta_hours: 0.02, max_hours: 0.03, expires_at: '2026-11-10T11:43:30.000Z', model: 'Qwen/Qwen3-8B', revision: REV,
  architecture: 'Qwen3ForCausalLM', gpu_count: 1, prompt_count: 2, samples_per_prompt: 1, max_new_tokens: 64, thinking: false,
  sampling, verification: 'draw', seed: 7, input_file_id: FILE, output_format: 'parquet', line_errors: 0,
  preview: [{ custom_id: 'm1', prompt_tokens: 30, text: 'What is 7 times 8?' }], purpose: 'eval', grader: 'boxed_math_v1',
  pricing: { mode: 'any_model', verification: 'draw', grading_fee_usd: 1 },
  capacity: { starts: 'queued', reason: 'waiting_for_capacity', queue_position: 2, estimated_start_at: null },
};
// The order.evaluation, price and deliveries recorded from production on 2026-11-09 (identifiers replaced).
const metrics = { n_problems: 2, samples: 1, expected_rows: 2, graded_rows: 2, ungraded_rows: 0, missing_rows: 0, mean_score: 0.5,
  n_problems_graded: 2, missing_problems: 0, requested_samples: 2, completed_samples: 2, graded_samples: 2, attempted_samples: null,
  tool_calls_total: null, mean_completion_tokens: 53, mean_turns: null, truncation_rate: 0.5, format_failure_rate: 0.5,
  stop_reasons: { length: 1, stop: 1 }, complete: true, 'pass@1': { value: 0.5, ci95: [0, 1] }, 'pass@k': { 1: 0.5 } };
const url = (delivery, name) => `/api/v1/dataset-orders/${ORDER}/deliveries/${delivery}/files/${name}`;
const order = {
  id: ORDER, status: 'delivered', model: 'Qwen/Qwen3-8B', revision: REV, input_file_id: FILE, output_format: 'openai_jsonl',
  verification: 'draw', seed: 7, gpu_count: 1, prompt_count: 2, samples_per_prompt: 1, max_new_tokens: 64, thinking: false, sampling,
  price_usd: 2.92513, cancel_requested: false, status_reason: null, needs_attention: false, progress: null,
  created_at: '2026-11-09T11:43:31.000Z', updated_at: '2026-11-09T11:55:51.000Z', finished_at: '2026-11-09T11:55:51.000Z',
  purpose: 'eval',
  evaluation: { grader: 'boxed_math_v1', status: 'graded', complete: true,
    summary: { complete: true, envs: { boxed_math_v1: metrics }, macro: { 'pass@1': 0.5, 'pass@k': { 1: 0.5 } } } },
  refunded_usd: 0.000016,
  deliveries: [
    { delivery_id: `dl-${ORDER}`, files: [{ name: 'output-00000.jsonl', size: 1255, sha256: 'b'.repeat(64), url: url(`dl-${ORDER}`, 'output-00000.jsonl') }] },
    { delivery_id: 'evaluation', files: [
      { name: 'graded.parquet', size: 4728, sha256: 'c'.repeat(64), url: url('evaluation', 'graded.parquet') },
      { name: 'manifest.json', size: 991, sha256: null, url: url('evaluation', 'manifest.json') },
      { name: 'report.json', size: 3869, sha256: 'd'.repeat(64), url: url('evaluation', 'report.json') }] }],
};
const liveCatalog = { ordering: 'pilot', any_model_ordering: 'pilot', envs: [], models: [],
  architectures: ['Qwen3ForCausalLM', 'Qwen3_5ForCausalLM', 'Qwen3_5ForConditionalGeneration'] };

test('release 0.12.0 pins the matching API package', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, '0.12.0');
  assert.equal(version, '0.12.0');
  assert.equal(pkg.dependencies['@reliquary/api'], 'file:vendor/api-client-0.12.0.tgz');
  assert.ok(pkg.files.includes('vendor/api-client-0.12.0.tgz'));
  const api = JSON.parse(await readFile(new URL('../node_modules/@reliquary/api/package.json', import.meta.url), 'utf8'));
  assert.equal(api.version, '0.12.0');
  assert.ok(OFFICIAL_SKILLS.some(skill => skill.id === 'reliquary-evaluation-file'));
});

test('batch quote takes an optional grader and checks it on the quote', async () => {
  const generation = generationRequests('key');
  const input = { model: 'Qwen/Qwen3-8B', revision: REV, input_file_id: FILE, grader: 'boxed_math_v1' };
  const { scope, generationResponse, generationExpected, ...request } = op('batch_quote').build({ model: 'Qwen/Qwen3-8B', revision: REV, inputFileId: FILE, grader: 'boxed_math_v1' });
  assert.deepEqual(request, generation.quote(input));
  assert.deepEqual(request.json, input);
  assert.deepEqual(generationExpected, { input });
  assert.equal(scope, 'orders');
  assert.equal(generationResponse, 'quote');
  assert.ok(!Object.hasOwn(op('batch_quote').build({ model: 'Qwen/Qwen3-8B', revision: REV, inputFileId: FILE }).json, 'grader'));
  for (const grader of ['judge', 'BOXED_MATH_V1', ''])
    assert.throws(() => op('batch_quote').build({ model: 'Qwen/Qwen3-8B', revision: REV, inputFileId: FILE, grader }));
  assert.deepEqual(op('batch_quote').schema.shape.grader.unwrap().options, [...FILE_GRADERS]);
  assert.match(op('batch_quote').description, /grading_fee_usd/);

  const api = new ApiClient(config, async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body), input);
    return Response.json(evaluationQuote, { status: 201 });
  });
  const quote = await api.request(op('batch_quote').build({ model: 'Qwen/Qwen3-8B', revision: REV, inputFileId: FILE, grader: 'boxed_math_v1' }));
  assert.equal(quote.purpose, 'eval');
  assert.equal(quote.grader, 'boxed_math_v1');
  assert.equal(quote.pricing.grading_fee_usd, 1);
  assert.equal(quote.architecture, 'Qwen3ForCausalLM');
  assert.deepEqual(quote.capacity, evaluationQuote.capacity);
  const changed = new ApiClient(config, async () => Response.json({ ...evaluationQuote, grader: 'exact_match_v1' }, { status: 201 }));
  await assert.rejects(changed.request(op('batch_quote').build({ model: 'Qwen/Qwen3-8B', revision: REV, inputFileId: FILE, grader: 'boxed_math_v1' })), { code: 'outcome_unknown' });
});

test('reading an order surfaces the evaluation summary', async () => {
  const api = new ApiClient(config, async () => Response.json({ order }));
  const read = await api.request(op('generation_order_get').build({ id: ORDER }));
  assert.deepEqual(read, parseGenerationResponse('order', { order }, 'key'));
  assert.equal(read.order.purpose, 'eval');
  assert.equal(read.order.evaluation.status, 'graded');
  assert.equal(read.order.evaluation.summary.envs.boxed_math_v1['pass@1'].value, 0.5);
  assert.match(op('generation_order_get').description, /evaluation/);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer(config, new ApiClient(config, async () => Response.json({ order })));
  const client = new Client({ name: 'release-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.callTool({ name: 'reliquary_batch_files', arguments: { orderId: ORDER } });
    assert.equal(listed.isError, undefined, JSON.stringify(listed));
    assert.deepEqual(listed.structuredContent.data.evaluation, order.evaluation);
    assert.deepEqual(listed.structuredContent.data.files.filter(f => f.deliveryId === 'evaluation').map(f => f.name), ['graded.parquet', 'manifest.json', 'report.json']);
    const viaTool = await client.callTool({ name: 'reliquary_generation_order_get', arguments: { id: ORDER } });
    assert.deepEqual(viaTool.structuredContent.data.order.evaluation, order.evaluation);
  } finally { await client.close(); await server.close(); }

  const queued = { ...order, status: 'queued', finished_at: null, status_reason: 'daily_capacity_reached', deliveries: [],
    evaluation: { grader: 'boxed_math_v1', status: 'pending', complete: null, summary: null },
    queue_position: 3, estimated_start_at: '2026-11-10T00:00:00.000Z' };
  const waiting = new ApiClient(config, async () => Response.json({ order: queued }));
  const readWaiting = (await waiting.request(op('generation_order_get').build({ id: ORDER }))).order;
  assert.equal(readWaiting.queue_position, 3);
  assert.equal(readWaiting.estimated_start_at, queued.estimated_start_at);
  assert.equal(readWaiting.status_reason, 'daily_capacity_reached');

  const { purpose: _purpose, evaluation: _evaluation, ...batchOrder } = order;
  const plain = new ApiClient(config, async () => Response.json({ order: batchOrder }));
  assert.ok(!Object.hasOwn((await plain.request(op('generation_order_get').build({ id: ORDER }))).order, 'evaluation'));
});

test('the generation catalog tool keeps architectures', async () => {
  const api = new ApiClient(config, async (_url, init) => {
    assert.equal(init.headers.get('Authorization'), null);
    return Response.json(liveCatalog);
  });
  const catalog = await api.request(op('generation_catalog').build({}));
  assert.deepEqual(catalog.architectures, liveCatalog.architectures);
  assert.equal((await new ApiClient(config, async () => Response.json({ ...liveCatalog, architectures: null })).request(op('generation_catalog').build({}))).architectures, null);
  assert.match(op('generation_catalog').description, /architectures/);
});

test('evaluation quotes accept the namespaced environment ids of the live catalog', () => {
  const args = { model: 'Qwen/Qwen3-8B', revision: REV, envs: [{ env: 'verifiers:aime25', set_id: 'verifiers-aime25-r0-n30', problems: 2, samples: 1 }], max_new_tokens: 64, thinking: false };
  assert.deepEqual(op('evaluation_quote').build(args).json, args);
  for (const env of [':aime', 'a/b', 'x'.repeat(65)]) assert.throws(() => op('evaluation_quote').build({ ...args, envs: [{ ...args.envs[0], env }] }));
  assert.throws(() => op('generation_pinned_quote').build({ model: 'org/model', revision: REV, env: 'verifiers:aime25', prompt_count: 1, samples_per_prompt: 1, max_new_tokens: 32, thinking: false }));
});

test('workflow context covers evaluations on a file and the OpenAI SDK route', () => {
  for (const needle of ['Evaluation on a file', 'grader', 'reference', 'grading_fee_usd', 'order.evaluation', 'https://app.reliqua.ai/api/openai/v1', 'architectures', '0.12 source candidate'])
    assert.ok(workflowText.includes(needle), needle);
  assert.ok(!workflowText.includes('0.11 source candidate'));
});

test('the skills catalog shows which products are not open yet', async () => {
  const closed = OFFICIAL_SKILLS.filter(skill => skill.state === 'not-yet-available').map(skill => skill.id);
  assert.ok(closed.includes('reliquary-generation-quote') && closed.includes('reliquary-training-start') && closed.includes('reliquary-cpu-validate') && closed.includes('reliquary-affine-pilot'));
  assert.ok(!closed.includes('reliquary-batch-files') && !closed.includes('reliquary-evaluation-file'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer(loadConfig({}));
  const client = new Client({ name: 'state-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const all = (await client.callTool({ name: 'reliquary_skills', arguments: {} })).structuredContent.data;
    assert.deepEqual(all.notYetAvailable, closed);
    assert.deepEqual(all.states, ['available', 'qualified-pilot', 'gated', 'not-yet-available']);
    assert.match(all.notice, /not-yet-available/);
    const filtered = (await client.callTool({ name: 'reliquary_skills', arguments: { state: 'not-yet-available' } })).structuredContent.data;
    assert.deepEqual(filtered.skills.map(skill => skill.id), closed);
    assert.ok(filtered.skills.every(skill => skill.availability.startsWith('Not yet available: ')));
    assert.match(filtered.skills.find(skill => skill.id === 'reliquary-generation-order').availability, /reliquary-batch-files/);
    const open = (await client.callTool({ name: 'reliquary_skills', arguments: { state: 'available' } })).structuredContent.data;
    assert.ok(open.skills.every(skill => skill.state === 'available' && !skill.availability));
    assert.equal((await client.callTool({ name: 'reliquary_skills', arguments: { state: 'closed' } })).isError, true);
  } finally { await client.close(); await server.close(); }
  assert.match(workflowText, /not-yet-available/);
  assert.match(workflowText, /compared but not rented/);
});
