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
