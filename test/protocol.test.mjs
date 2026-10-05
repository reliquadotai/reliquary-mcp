import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
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
    return Response.json({ execution: 'disabled', observedAt: null });
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
    assert.equal(catalog.structuredContent.data.execution, 'disabled');
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
