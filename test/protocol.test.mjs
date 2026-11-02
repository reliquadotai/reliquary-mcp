import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { request, createServer } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { loadConfig } from '../dist/config.js';
import { buildServer } from '../dist/server.js';
import { createHttpServer } from '../dist/http.js';
import { ApiClient } from '../dist/api.js';

const keys = { resources: '1', orders: '2', evaluations: '3', training: '4' };
const env = Object.fromEntries(Object.entries(keys).map(([scope, n]) => [`RELIQUARY_${scope.toUpperCase()}_KEY`, 'rlq_' + n.repeat(48)]));
async function memory(config, api) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer(config, api);
  await server.connect(serverTransport);
  const client = new Client({ name: 'contract-test', version: '1.0.0' });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test('MCP discovery hides writes and unavailable credential corridors', async () => {
  const session = await memory(loadConfig({}));
  try {
    const { tools } = await session.client.listTools();
    assert(tools.some(t => t.name === 'reliquary_connection'));
    assert(!tools.some(t => t.name === 'reliquary_training_start'));
    assert(!tools.some(t => t.name === 'reliquary_resources_list'));
    assert(tools.every(t => t.annotations.readOnlyHint));
    const connection = await session.client.callTool({ name: 'reliquary_connection', arguments: {} });
    assert.equal(connection.structuredContent.data.apiOrigin, 'https://api.reliqua.ai');
    assert.equal(session.client.getServerVersion().version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);
    const resource = await session.client.readResource({ uri: 'reliquary://workflows' });
    assert(resource.contents[0].text.includes('idempotencyKey'));
    const prompt = await session.client.getPrompt({ name: 'reliquary-workflow', arguments: { goal: 'Prepare a run' } });
    assert(prompt.messages[0].content.text.includes('Prepare a run'));
  } finally { await session.close(); }
});

test('actual MCP quote and launch preserve exact approval, scoped key and retry identity', async () => {
  const calls = [];
  let launches = 0;
  const config = loadConfig({ ...env, RELIQUARY_ENABLE_WRITES: 'true' });
  const api = new ApiClient(config, async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.pathname, init, body });
    if (url.pathname.endsWith('/quotes')) return Response.json({ quote: { id: 'quote-1', maxCostMicroUsd: 2_000_000 } });
    if (init.method === 'POST' && url.pathname.endsWith('/tasks')) {
      launches++;
      if (launches === 1) throw new Error('ambiguous network result');
      return Response.json({ task: { id: 'task-1', status: 'queued' } });
    }
    return Response.json({ ordering: 'disabled', any_model_ordering: 'disabled', envs: [], models: [] });
  });
  const session = await memory(config, api);
  try {
    const call = (name, args) => session.client.callTool({ name: 'reliquary_' + name, arguments: args });
    const quote = await call('training_quote', { draftId: 'draft-1', datasetId: 'file-1', revision: 3 });
    assert.equal(quote.structuredContent.data.quote.id, 'quote-1');
    const invalid = await call('training_start', { draftId: 'draft-1', datasetId: 'file-1', revision: 3, quoteId: 'quote-1', idempotencyKey: 'stable-request-123456', approveExecution: false });
    assert(invalid.isError);
    assert.equal(calls.length, 1);
    const launch = { draftId: 'draft-1', datasetId: 'file-1', revision: 3, quoteId: 'quote-1', idempotencyKey: 'stable-request-123456', approveExecution: true };
    const unknown = await call('training_start', launch);
    assert.equal(unknown.structuredContent.data.error.code, 'outcome_unknown');
    assert.equal(unknown.structuredContent.data.error.idempotencyKey, launch.idempotencyKey);
    const retry = await call('training_start', launch);
    assert.equal(retry.structuredContent.data.task.id, 'task-1');
    assert.equal(calls[1].init.headers.get('Idempotency-Key'), calls[2].init.headers.get('Idempotency-Key'));
    assert.equal(calls[1].init.headers.get('Authorization'), 'Bearer rlq_' + '4'.repeat(48));
    assert.deepEqual(calls[1].body, { draftId: 'draft-1', datasetId: 'file-1', revision: 3, quoteId: 'quote-1', approveExecution: true });
    assert(!('idempotencyKey' in calls[1].body));
    const catalog = await call('generation_catalog', {});
    assert.equal(catalog.structuredContent.data.ordering, 'disabled');
    assert.equal(calls.at(-1).init.headers.get('Authorization'), null);
  } finally { await session.close(); }
});

test('MCP training task reads preserve partial steps and legacy results', async () => {
  const fixtures = [
    { task: { id: 'task-1', status: 'succeeded' }, configuration: { optimization: { maxSteps: 50 } }, result: { reloadVerified: true, steps: 47 }, events: [{ sequence: 1, status: 'running', message: 'Training step 40 completed.' }] },
    { task: { id: 'task-1', status: 'succeeded' }, result: { reloadVerified: true } },
  ];
  let reads = 0;
  const config = loadConfig({ RELIQUARY_TRAINING_KEY: env.RELIQUARY_TRAINING_KEY });
  const api = new ApiClient(config, async (url, init) => {
    assert.equal(url.pathname, '/api/v1/training/tasks/task-1');
    assert.equal(init.method, 'GET');
    return Response.json(fixtures[reads++]);
  });
  const session = await memory(config, api);
  try {
    for (const fixture of fixtures) {
      const response = await session.client.callTool({ name: 'reliquary_training_task_get', arguments: { id: 'task-1' } });
      const text = JSON.parse(response.content.find(item => item.type === 'text').text);
      assert.deepEqual(response.structuredContent.data, fixture);
      assert.deepEqual(text, fixture);
      assert.equal(Object.hasOwn(response.structuredContent.data.result, 'steps'), Object.hasOwn(fixture.result, 'steps'));
      assert.equal(Object.hasOwn(text.result, 'steps'), Object.hasOwn(fixture.result, 'steps'));
    }
    assert.equal(reads, 2);
  } finally { await session.close(); }
});

test('authenticated HTTP transport works; token, Host and Origin gates fail closed', async () => {
  const config = loadConfig({ RELIQUARY_TRANSPORT: 'http', RELIQUARY_MCP_TOKEN: 't'.repeat(48) });
  const server = createHttpServer(config, () => buildServer(config));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = new Client({ name: 'http-test', version: '1.0.0' });
  try {
    assert.equal((await fetch(base + '/healthz')).status, 200);
    assert.equal((await fetch(base + '/mcp', { method: 'POST' })).status, 401);
    assert.equal((await fetch(base + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer invalid' } })).status, 401);
    assert.equal((await fetch(base + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + config.mcpToken, Origin: 'https://foreign.example' } })).status, 403);
    const badHostStatus = await new Promise((resolve, reject) => {
      const req = request(base + '/mcp', { method: 'POST', headers: { Host: 'foreign.example', Authorization: 'Bearer ' + config.mcpToken } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(badHostStatus, 403);
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + config.mcpToken } } }));
    const connection = await client.callTool({ name: 'reliquary_connection', arguments: {} });
    assert.equal(connection.structuredContent.data.accountMode, 'single-account');
    assert(!JSON.stringify(connection).includes(config.mcpToken));
    const legacyCall = async payload => {
      const response = await fetch(base + '/mcp', {
        method: 'POST', headers: { Authorization: 'Bearer ' + config.mcpToken, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' }, body: JSON.stringify(payload),
      });
      assert.equal(response.status, 200);
      const text = await response.text();
      return JSON.parse(text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').find(line => line.startsWith('data:')).slice(5).trim() : text);
    };
    const initialize = await legacyCall({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-test', version: '1.0.0' } } });
    assert.equal(initialize.result.protocolVersion, '2025-11-25');
    const legacyTools = await legacyCall({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert(legacyTools.result.tools.some(tool => tool.name === 'reliquary_connection'));
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('stdio process speaks MCP without startup output on protocol stream', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'], env: {}, stderr: 'pipe' });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert(tools.length >= 10);
    assert.equal((await client.callTool({ name: 'reliquary_connection', arguments: {} })).structuredContent.data.writesEnabled, false);
    assert.equal(stderr, '');
  } finally { await client.close(); }
});

test('both transports accept the full 5 MiB file cap inside an escaped MCP envelope', async () => {
  const limit = 5 * 1024 * 1024;
  const row = JSON.stringify({ prompt: 'Question', response: 'Answer' }) + '\n';
  const jsonl = '\t'.repeat(limit - Buffer.byteLength(row)) + row;
  assert.equal(Buffer.byteLength(jsonl), limit);
  assert(Buffer.byteLength(JSON.stringify({ jsonl })) > 10 * 1024 * 1024 - 100);
  let uploads = 0;
  const backend = createServer(async (req, res) => {
    let bytes = 0;
    for await (const chunk of req) bytes += chunk.length;
    assert.equal(req.url, '/api/v1/training/files');
    assert.equal(bytes, limit);
    uploads++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ file: { id: 'boundary-file' } }));
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const childEnv = {
    RELIQUARY_API_URL: `http://127.0.0.1:${backend.address().port}`,
    RELIQUARY_ALLOW_LOCAL_HTTP: 'true', RELIQUARY_ENABLE_WRITES: 'true',
    RELIQUARY_TRAINING_KEY: env.RELIQUARY_TRAINING_KEY,
  };
  try {
    for (const mode of ['stdio', 'http']) {
      let http;
      let transport;
      if (mode === 'stdio') {
        transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'], env: childEnv, stderr: 'pipe' });
      } else {
        const config = loadConfig({ ...childEnv, RELIQUARY_TRANSPORT: 'http', RELIQUARY_MCP_TOKEN: 'u'.repeat(48) });
        http = createHttpServer(config, () => buildServer(config));
        http.listen(0, '127.0.0.1');
        await once(http, 'listening');
        transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer ' + config.mcpToken } } });
      }
      const client = new Client({ name: 'upload-boundary-test', version: '1.0.0' });
      try {
        await client.connect(transport);
        const result = await client.callTool({ name: 'reliquary_training_upload', arguments: { name: 'boundary.jsonl', format: 'instruction', jsonl, rightsConfirmed: true } });
        assert.equal(result.structuredContent.data.file.id, 'boundary-file');
      } finally {
        await client.close();
        if (http) { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); }
      }
    }
    assert.equal(uploads, 2);
  } finally { backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); }
});

test('Affine discovery gates writes; ambiguous preparation preserves original UUID without retry', async () => {
  for (const configured of [{}, { RELIQUARY_TRAINING_KEY: env.RELIQUARY_TRAINING_KEY }]) {
    const session = await memory(loadConfig(configured));
    try {
      const { tools } = await session.client.listTools();
      assert.equal(tools.some(t => t.name === 'reliquary_affine_pilot_status'), Boolean(configured.RELIQUARY_TRAINING_KEY));
      assert(!tools.some(t => t.name === 'reliquary_affine_checkpoint_prepare'));
      assert(!tools.some(t => t.name === 'reliquary_affine_checkpoint_review'));
      assert(!tools.some(t => t.name === 'reliquary_affine_evaluation_prepare'));
      assert(!tools.some(t => t.name === 'reliquary_affine_request_upload'));
    } finally { await session.close(); }
  }
  const calls = [];
  const config = loadConfig({ ...env, RELIQUARY_ENABLE_WRITES: 'true' });
  const session = await memory(config, new ApiClient(config, async (url, init) => {
    calls.push({ url, init }); throw new Error('unknown transport outcome');
  }));
  try {
    const input = { repository: 'org/model', revision: 'a'.repeat(40), sessionId: 'session-1', maxCostMicroUsd: 5_100_000,
      policyDigest: 'b'.repeat(64), requestId: '11111111-1111-4111-8111-111111111111', approvePreparation: true };
    const call = args => session.client.callTool({ name: 'reliquary_affine_checkpoint_prepare', arguments: args });
    assert((await call({ ...input, approvePreparation: false })).isError);
    assert.equal(calls.length, 0);
    const result = await call(input);
    assert.equal(result.structuredContent.data.error.code, 'outcome_unknown');
    assert.equal(result.structuredContent.data.error.idempotencyKey, input.requestId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.pathname, '/api/v1/training/affine-native-evaluation/preparations');
    assert.equal(calls[0].init.headers.get('Idempotency-Key'), input.requestId);
    assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer ' + env.RELIQUARY_TRAINING_KEY);
    assert.equal(calls[0].init.credentials, 'omit');
    assert.deepEqual(JSON.parse(calls[0].init.body), input);
    await call(input);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.body, calls[1].init.body);
    assert.equal(calls[0].init.headers.get('Idempotency-Key'), calls[1].init.headers.get('Idempotency-Key'));
  } finally { await session.close(); }
});

test('Affine status validates server metadata before presenting availability', async () => {
  const config = loadConfig({ RELIQUARY_TRAINING_KEY: env.RELIQUARY_TRAINING_KEY });
  const fixtures = [
    { available: false, reason: 'Unavailable', sessionId: null, windowEndsAt: null, preparations: [] },
    { available: true, reason: null, sessionId: null, windowEndsAt: null, preparations: [] },
  ];
  const session = await memory(config, new ApiClient(config, async () => Response.json(fixtures.shift())));
  try {
    const call = () => session.client.callTool({ name: 'reliquary_affine_pilot_status', arguments: {} });
    assert.equal((await call()).structuredContent.data.available, false);
    assert.equal((await call()).structuredContent.data.error.code, 'invalid_response');
  } finally { await session.close(); }
});

test('local batch review and plan run without credentials, writes or any upstream calls', async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new Error('No fetch permitted'); };
  const session = await memory(loadConfig({}), { request: async () => { calls++; throw new Error('No upstream permitted'); } });
  const batchJson = ' {"version":"affine-batch-v1","hotkey":"fixture-owner","groups":[{"prompt":"Question","rollouts":[{"output":"Answer","reward":1}]}]}\n';
  const miningJson = JSON.stringify({epoch:'fixture-1',checkpoint:'a'.repeat(64),training:{batch_cap:{max_tasks_per_miner:125,max_rollouts_per_miner:1000}},batch_file:{formats:['affine-batch-v1','affine-batch-v2'],train:{fields:{lr:{min:1.25e-7,max:1e-6,default:5e-7},kl:{min:0.005,max:0.1,default:0.02}}}}});
  try {
    const {tools}=await session.client.listTools();
    for(const name of ['reliquary_affine_batch_review','reliquary_affine_batch_plan']) assert.deepEqual(tools.find(t=>t.name===name).annotations,{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false});
    const args={batchJson,miningJson,hotkey:'fixture-owner'};
    const call=(name,input)=>session.client.callTool({name:'reliquary_affine_batch_'+name,arguments:input});
    const review=await call('review',args);assert(!review.isError);assert.equal(review.structuredContent.data.prompts,1);assert.equal(review.structuredContent.data.rollouts,1);assert.equal(review.structuredContent.data.tokenValidation,'not_run');
    const plan=await call('plan',{...args,head:'b'.repeat(64),reference:'c'.repeat(64),master:'bf16-bootstrap',seed:42,prior:'env-average',trainingResultAt:21600,lastGreenDecidedAt:0});assert(!plan.isError);assert.equal(plan.structuredContent.data.schema,'affine-batch-plan/v1');assert.equal(plan.structuredContent.data.batch.sha256,review.structuredContent.data.sha256);assert.equal(plan.structuredContent.data.comparison.barZ,0.625);assert.equal(plan.structuredContent.data.liveParity,false);
    for(const change of [{batchJson:'x'.repeat(1024*1024+1)},{batchJson:'not JSON'},{path:'/tmp/batch.json'},{apiKey:'not-permitted'},{batchJson:batchJson.replace('"reward":1','"reward":true')}])assert((await call('review',{...args,...change})).isError);
    assert.equal(calls,0);
  } finally {globalThis.fetch = originalFetch; await session.close();}
});

test('hosted batch preparation and metadata upload reuse scoped gated tools', async () => {
  const request = { schema: 'affine-batch-request/v1', profileDigest: 'a'.repeat(64), jobDigest: 'b'.repeat(64), maxHours: 4, maxCostMicroUsd: 25_000_000, jobExpiresAt: 4_000_000_000 };
  const prepared = request => ({ request, mode: 'operator-funded-pilot', configuration: {
    schemaVersion: 2, profileDigest: request.profileDigest,
    objective: 'Run one approved native MiMo GRPO step and parent/candidate comparison.',
    environment: { id: 'fixture', version: '1' }, model: { id: 'fixture/model' },
    optimization: { method: 'affine_batch', maxSteps: 1 },
    compute: { offerId: 'fixture', gpuCount: 1, maxHours: request.maxHours, providerPolicy: 'private' },
    affineBatchRequest: request, submissionMode: 'operator_funded_pilot',
  } });
  const input = { profileDigest: request.profileDigest, maxHours: request.maxHours, maxCostMicroUsd: request.maxCostMicroUsd };
  const readonly = await memory(loadConfig({ RELIQUARY_TRAINING_KEY: env.RELIQUARY_TRAINING_KEY }));
  try {
    const { tools } = await readonly.client.listTools();
    assert(!tools.some(t => t.name === 'reliquary_affine_batch_prepare'));
    assert(!tools.some(t => t.name === 'reliquary_training_upload'));
    assert(tools.some(t => t.name === 'reliquary_training_task_get'));
  } finally { await readonly.close(); }
  const calls = [];
  let responseRequest = request;
  const cfg = loadConfig({ ...env, RELIQUARY_ENABLE_WRITES: 'true' });
  const session = await memory(cfg, new ApiClient(cfg, async (url, init) => {
    calls.push({ url, init });
    return Response.json(url.pathname.endsWith('/prepare') ? prepared(responseRequest) : { file: { id: 'file-fixture' } });
  }));
  try {
    const prepare = () => session.client.callTool({ name: 'reliquary_affine_batch_prepare', arguments: input });
    assert.deepEqual((await prepare()).structuredContent.data, prepared(request));
    assert.equal(calls[0].url.pathname, '/api/v1/training/affine-batch/prepare');
    assert.deepEqual(JSON.parse(calls[0].init.body), input);
    assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer ' + env.RELIQUARY_TRAINING_KEY);
    assert.equal(calls[0].init.credentials, 'omit');
    for (const changed of [{ profileDigest: 'c'.repeat(64) }, { maxHours: 3 }, { maxCostMicroUsd: 1 }, { jobExpiresAt: 1 }]) {
      responseRequest = { ...request, ...changed };
      const result = await prepare();
      assert.equal(result.structuredContent.data.error.code, 'outcome_unknown');
    }
    assert.equal(calls.length, 5, 'No automatic replay');
    const upload = args => session.client.callTool({ name: 'reliquary_training_upload', arguments: {
      name: 'affine-batch-request.jsonl', format: 'affine_batch_request', jsonl: JSON.stringify(request) + '\n', rightsConfirmed: true, ...args,
    } });
    const before = calls.length;
    for (const args of [
      { rightsConfirmed: false }, { jsonl: JSON.stringify({ ...request, extra: true }) },
      { jsonl: JSON.stringify({ ...request, jobDigest: 'invalid' }) }, { jsonl: '[{"prompt":"raw batch"}]' },
      { jsonl: JSON.stringify(request) + '\n' + JSON.stringify(request) },
      { jsonl: ' '.repeat(4096) + JSON.stringify(request) },
    ]) assert((await upload(args)).isError);
    assert.equal(calls.length, before, 'Invalid metadata must not reach upstream');
    assert.equal((await upload({})).structuredContent.data.file.id, 'file-fixture');
    const last = calls.at(-1);
    assert.equal(last.url.pathname, '/api/v1/training/files');
    assert.equal(last.init.headers.get('X-Dataset-Format'), 'affine_batch_request');
    assert.equal(last.init.headers.get('X-Data-Authorized'), 'true');
    assert.equal(last.init.body, JSON.stringify(request) + '\n');
    const start = await session.client.callTool({ name: 'reliquary_training_start', arguments: {
      draftId: 'draft-fixture', datasetId: 'file-fixture', revision: 1, approveExecution: false, idempotencyKey: 'stable-batch-start-1234',
    } });
    assert(start.isError);
    assert.equal(calls.length, before + 1, 'Preparation/upload cannot bypass start approval');
  } finally { await session.close(); }
});
