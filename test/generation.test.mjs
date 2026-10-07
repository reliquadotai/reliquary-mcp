import test from 'node:test';
import assert from 'node:assert/strict';
import { generationRequests, parseGenerationResponse } from '@reliquary/api';
import { ApiClient } from '../dist/api.js';
import { loadConfig } from '../dist/config.js';
import { operations } from '../dist/tools.js';

const op = name => operations.find(value => value.name === 'reliquary_' + name);
const generation = generationRequests('key');
const key = 'stable-request-key-123456';
const token = 'rlq_' + '2'.repeat(48);
const config = loadConfig({ RELIQUARY_ORDERS_KEY: token, RELIQUARY_ENABLE_WRITES: 'true' });
const input = { model: 'fixture-model', source: 'fixture-source', prompt_count: 1,
  samples_per_prompt: 1, max_new_tokens: 32, thinking: false };
const catalog = { ordering: 'disabled', any_model_ordering: 'disabled', envs: [], models: [] };
const quote = { ...input, quote_id: 'quote-1', price_usd: 1, est_tokens: 32, eta_hours: 0.1,
  expires_at: '2030-01-01T00:00:00Z' };
const order = { ...input, id: 'order-1', status: 'queued', price_usd: 1, cancel_requested: false,
  status_reason: null, needs_attention: false, progress: null, created_at: '2030-01-01T00:00:00Z',
  updated_at: '2030-01-01T00:00:00Z', finished_at: null, refunded_usd: 0, deliveries: [] };

test('generation tools share all seven request builders, credentials and bounded ranges', () => {
  const pinned = { model: 'org/model', revision: 'a'.repeat(40), env: 'math', prompt_count: 1,
    samples_per_prompt: 1, max_new_tokens: 32, thinking: false };
  const cases = [
    ['generation_catalog', {}, generation.catalog(), 'catalog'],
    ['generation_quote', input, generation.quote(input), 'quote'],
    ['generation_pinned_quote', pinned, generation.quote(pinned), 'quote'],
    ['generation_order', { quote_id: 'quote-1', idempotencyKey: key, approveExecution: true }, generation.create('quote-1', key), 'order'],
    ['generation_orders', {}, generation.orders(), 'orders'],
    ['generation_order_get', { id: 'order-1' }, generation.detail('order-1'), 'order'],
    ['generation_cancel', { id: 'order-1', approveExecution: true }, generation.cancel('order-1'), 'order'],
    ['generation_download', { orderId: 'order-1', deliveryId: 'delivery-1', fileName: 'report.json', offset: 10, maxBytes: 25 }, generation.download('order-1', 'delivery-1', 'report.json', { offset: 10, maxBytes: 25 }), undefined],
  ];
  for (const [name, args, expected, response] of cases) {
    const { scope, generationResponse, generationExpected, ...actual } = op(name).build(args);
    assert.deepEqual(actual, expected, name);
    assert.equal(scope, name === 'generation_catalog' ? undefined : 'orders');
    assert.equal(generationResponse, response);
    assert.deepEqual(generationExpected, name.includes('quote') ? { input: args } : name === 'generation_order_get' || name === 'generation_cancel' ? { id: args.id } : undefined);
  }
  assert.throws(() => op('generation_order').build({ quote_id: 'quote-1', idempotencyKey: key, approveExecution: false }));
  assert.throws(() => op('generation_cancel').build({ id: 'order-1', approveExecution: false }));
  assert.throws(() => op('generation_download').build({ orderId: 'order-1', deliveryId: 'delivery-1', fileName: '../report.json' }));
  assert.throws(() => op('generation_download').build({ orderId: 'order-1', deliveryId: 'delivery-1', fileName: 'report.json', maxBytes: 262145 }));
});

test('generation JSON uses the shared validated key response model', async () => {
  const cases = [
    ['generation_catalog', {}, 'catalog', catalog],
    ['generation_quote', input, 'quote', quote],
    ['generation_order', { quote_id: 'quote-1', idempotencyKey: key, approveExecution: true }, 'order', { order }],
    ['generation_orders', {}, 'orders', { orders: [order] }],
    ['generation_order_get', { id: 'order-1' }, 'order', { order }],
    ['generation_cancel', { id: 'order-1', approveExecution: true }, 'order', { order }],
  ];
  for (const [name, args, responseOperation, body] of cases) {
    let calls = 0;
    const api = new ApiClient(config, async (_url, init) => {
      calls++;
      assert.equal(init.headers.get('Authorization'), name === 'generation_catalog' ? null : `Bearer ${token}`);
      return Response.json(body);
    });
    assert.deepEqual(await api.request(op(name).build(args)), parseGenerationResponse(responseOperation, body, 'key'));
    assert.equal(calls, 1);
  }
});

test('malformed generation mutations preserve ambiguous outcome and original launch key', async () => {
  let calls = 0;
  const api = new ApiClient(config, async () => { calls++; return Response.json({ order: { id: 'order-1', status: 'queued' } }); });
  await assert.rejects(api.request(op('generation_order').build({ quote_id: 'quote-1', idempotencyKey: key, approveExecution: true })),
    { code: 'outcome_unknown', retryKey: key, status: 200 });
  await assert.rejects(api.request(op('generation_order_get').build({ id: 'order-1' })), { code: 'invalid_response', status: 200 });
  await assert.rejects(api.request(op('generation_cancel').build({ id: 'order-1', approveExecution: true })), { code: 'outcome_unknown', status: 200 });
  assert.equal(calls, 3);
});

test('generation downloads retain the existing binary transport and range limit', async () => {
  const api = new ApiClient(config, async (_url, init) => {
    assert.equal(init.headers.get('Range'), 'bytes=0-4');
    assert.equal(init.headers.get('Authorization'), `Bearer ${token}`);
    return new Response('hello', { status: 206, headers: { 'Content-Range': 'bytes 0-4/5' } });
  });
  const result = await api.request(op('generation_download').build({ orderId: 'order-1', deliveryId: 'delivery-1', fileName: 'report.json', maxBytes: 5 }));
  assert.equal(result.data, Buffer.from('hello').toString('base64'));
  assert.equal(result.bytes, 5);
  assert.equal(result.contentRange, 'bytes 0-4/5');
});

test('shared response checks reject another order and changed quote configuration', async () => {
  const changedOrder = new ApiClient(config, async () => Response.json({ order: { ...order, id: 'order-2' } }));
  await assert.rejects(changedOrder.request(op('generation_order_get').build({ id: 'order-1' })), { code: 'invalid_response' });
  await assert.rejects(changedOrder.request(op('generation_cancel').build({ id: 'order-1', approveExecution: true })), { code: 'outcome_unknown' });
  const changedQuote = new ApiClient(config, async () => Response.json({ ...quote, thinking: true }));
  await assert.rejects(changedQuote.request(op('generation_quote').build(input)), { code: 'outcome_unknown' });
});
