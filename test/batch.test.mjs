import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { generationRequests } from '@reliquary/api';
import { ApiClient } from '../dist/api.js';
import { availableBatchTools } from '../dist/batch.js';
import { loadConfig } from '../dist/config.js';
import { buildServer } from '../dist/server.js';
import { operations } from '../dist/tools.js';

const op = name => operations.find(value => value.name === 'reliquary_' + name);
const token = 'rlq_' + '3'.repeat(48);
const key = 'stable-request-key-123456';
const REV = 'a'.repeat(40);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('batch quote and order build the shared file-quote requests', () => {
  const generation = generationRequests('key');
  const input = { model: 'org/model', revision: REV, input_file_id: 'file-1', output_format: 'openai_jsonl' };
  const { scope, generationResponse, generationExpected, ...quote } = op('batch_quote').build({ model: 'org/model', revision: REV, inputFileId: 'file-1', outputFormat: 'openai_jsonl' });
  assert.deepEqual(quote, generation.quote(input));
  assert.equal(scope, 'orders');
  assert.equal(generationResponse, 'quote');
  assert.deepEqual(generationExpected, { input });
  for (const bad of [{ model: 'org/model', revision: 'main', inputFileId: 'file-1' }, { model: 'org/model', revision: REV, inputFileId: '../x' },
    { model: 'org/model', revision: REV, inputFileId: 'file-1', outputFormat: 'csv' }])
    assert.throws(() => op('batch_quote').build(bad));
  const order = op('batch_order').build({ quoteId: 'quote-1', idempotencyKey: key, approveExecution: true });
  assert.deepEqual({ path: order.path, method: order.method, headers: order.headers, json: order.json }, generation.create('quote-1', key));
  assert.equal(op('batch_order').spend, true);
  assert.equal(op('batch_file_get').build({ fileId: 'file-1' }).path, '/api/v1/files/file-1');
});

test('disk tools exist only on a local process with the orders key; uploads also need writes', () => {
  const names = env => availableBatchTools(loadConfig(env)).map(tool => tool.name).sort();
  assert.deepEqual(names({}), []);
  assert.deepEqual(names({ RELIQUARY_ORDERS_KEY: token }), ['reliquary_batch_download', 'reliquary_batch_files']);
  assert.deepEqual(names({ RELIQUARY_ORDERS_KEY: token, RELIQUARY_ENABLE_WRITES: 'true' }),
    ['reliquary_batch_download', 'reliquary_batch_files', 'reliquary_batch_upload']);
  assert.deepEqual(names({ RELIQUARY_ORDERS_KEY: token, RELIQUARY_ENABLE_WRITES: 'true', RELIQUARY_TRANSPORT: 'http', RELIQUARY_MCP_TOKEN: 't'.repeat(32), RELIQUARY_PUBLIC_URL: 'https://mcp.example.test' }).filter(Boolean),
    ['reliquary_batch_files']);
});

function platform() {
  const files = new Map();
  const output = Buffer.from('{"id":"r1","custom_id":"a","response":{"status_code":200},"error":null}\n'.repeat(20));
  const report = Buffer.from('{"schema":"reliquary/corpus-delivery/v3"}');
  const order = { model: 'org/model', revision: REV, input_file_id: 'file-1', prompt_count: 1, samples_per_prompt: 1, max_new_tokens: 64,
    sampling: { temperature: 1, top_p: 1, top_k: 0 }, id: 'order-1', status: 'delivered', price_usd: 1, cancel_requested: false, status_reason: null,
    needs_attention: false, progress: null, created_at: '2030-01-01T00:00:00Z', updated_at: '2030-01-01T00:00:00Z', finished_at: null,
    refunded_usd: 0, deliveries: [{ delivery_id: 'dl-1', files: [
      { name: 'output-00000.jsonl', size: output.length, sha256: sha(output), url: '/api/v1/dataset-orders/order-1/deliveries/dl-1/files/output-00000.jsonl' },
      { name: 'report.json', size: report.length, sha256: sha(report), url: '/api/v1/dataset-orders/order-1/deliveries/dl-1/files/report.json' }] }] };
  const served = { 'output-00000.jsonl': output, 'report.json': report };
  const seen = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', c => chunks.push(c));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: request.method, url: request.url, auth: request.headers.authorization });
      const json = (status, value) => { response.statusCode = status; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
      let m;
      if (request.method === 'POST' && request.url === '/api/v1/files') {
        const input = JSON.parse(body);
        files.set('file-1', { ...input, parts: [] });
        return json(201, { id: 'file-1', object: 'file', bytes: input.bytes, filename: input.filename, purpose: 'batch', status: 'uploading',
          created_at: '2030-01-01T00:00:00Z', upload: { part_size: 1024, parts: Math.ceil(input.bytes / 1024) } });
      }
      if ((m = request.url.match(/^\/api\/v1\/files\/file-1\/parts\/(\d+)$/))) { files.get('file-1').parts[Number(m[1]) - 1] = body; return json(200, { part: Number(m[1]), etag: 'e' }); }
      if (request.url === '/api/v1/files/file-1/complete') {
        const file = files.get('file-1');
        file.content = Buffer.concat(file.parts);
        return json(200, { id: 'file-1', object: 'file', bytes: file.bytes, filename: file.filename, purpose: 'batch', status: 'processed', created_at: '2030-01-01T00:00:00Z' });
      }
      if (request.url === '/api/v1/dataset-orders/order-1') return json(200, { order });
      if ((m = request.url.match(/^\/api\/v1\/dataset-orders\/order-1\/deliveries\/dl-1\/files\/(.+)$/))) {
        const bytes = served[decodeURIComponent(m[1])];
        response.setHeader('Content-Length', String(bytes.length));
        return response.end(bytes);
      }
      return json(404, { error: { code: 'not_found' } });
    });
  });
  return { server, files, seen, output };
}

async function connect(config) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer(config, new ApiClient(config));
  const client = new Client({ name: 'batch-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

test('an agent uploads a local file and saves a delivery without any content entering its context', async () => {
  const fake = platform();
  await new Promise(r => fake.server.listen(0, '127.0.0.1', r));
  try {
    const config = loadConfig({ RELIQUARY_ORDERS_KEY: token, RELIQUARY_ENABLE_WRITES: 'true', RELIQUARY_ALLOW_LOCAL_HTTP: 'true',
      RELIQUARY_API_URL: `http://127.0.0.1:${fake.server.address().port}` });
    const client = await connect(config);
    const dir = await mkdtemp(join(tmpdir(), 'mcp-batch-'));
    const input = Buffer.from('{"custom_id":"secret-prompt-marker","method":"POST","url":"/v1/chat/completions","body":{}}\n'.repeat(60));
    await writeFile(join(dir, 'requests.jsonl'), input);
    const refused = await client.callTool({ name: 'reliquary_batch_upload', arguments: { path: join(dir, 'requests.jsonl'), rightsConfirmed: true, approveExecution: false } });
    assert.equal(refused.isError, true);
    const notJsonl = await client.callTool({ name: 'reliquary_batch_upload', arguments: { path: join(dir, 'nope.txt'), rightsConfirmed: true, approveExecution: true } });
    assert.equal(notJsonl.isError, true);
    const uploaded = await client.callTool({ name: 'reliquary_batch_upload', arguments: { path: join(dir, 'requests.jsonl'), rightsConfirmed: true, approveExecution: true } });
    assert.equal(uploaded.isError, undefined, JSON.stringify(uploaded));
    assert.equal(uploaded.structuredContent.data.file.status, 'processed');
    assert.deepEqual(fake.files.get('file-1').content, input);
    assert.ok(!JSON.stringify(uploaded).includes('secret-prompt-marker'));
    const listed = await client.callTool({ name: 'reliquary_batch_files', arguments: { orderId: 'order-1' } });
    assert.deepEqual(listed.structuredContent.data.files.map(f => f.name), ['output-00000.jsonl', 'report.json']);
    assert.ok(listed.structuredContent.data.files[0].url.startsWith(config.apiUrl + '/api/v1/dataset-orders/order-1/'));
    const saved = await client.callTool({ name: 'reliquary_batch_download', arguments: { orderId: 'order-1', directory: join(dir, 'out') } });
    assert.equal(saved.isError, undefined, JSON.stringify(saved));
    assert.deepEqual(await readFile(join(dir, 'out', 'dl-1', 'output-00000.jsonl')), fake.output);
    assert.ok(saved.structuredContent.data.files.every(f => f.verified));
    assert.ok(!JSON.stringify(saved).includes('custom_id'));
    assert.ok(fake.seen.every(r => r.auth === `Bearer ${token}`));
  } finally { await new Promise(r => fake.server.close(r)); }
});

test('without writes the upload tool is not offered and the connection says so', async () => {
  const client = await connect(loadConfig({ RELIQUARY_ORDERS_KEY: token }));
  const { tools } = await client.listTools();
  const names = tools.map(tool => tool.name);
  assert.ok(names.includes('reliquary_batch_download') && !names.includes('reliquary_batch_upload'));
  const connection = (await client.callTool({ name: 'reliquary_connection', arguments: {} })).structuredContent.data;
  assert.ok(connection.tools.includes('reliquary_batch_files') && !connection.tools.includes('reliquary_batch_upload'));
});
