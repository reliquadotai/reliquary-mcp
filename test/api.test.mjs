import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../dist/config.js';
import { ApiClient } from '../dist/api.js';

const key = 'rlq_' + '1'.repeat(48);
const config = loadConfig({ RELIQUARY_RESOURCES_KEY: key, RELIQUARY_ENABLE_WRITES: 'true' });
test('configuration rejects unsafe origins and invalid credentials', () => {
  for (const url of ['http://example.com', 'https://u:p@example.com', 'https://example.com/path', 'https://example.com?x=1']) {
    assert.throws(() => loadConfig({ RELIQUARY_API_URL: url }));
  }
  assert.throws(() => loadConfig({ RELIQUARY_RESOURCES_KEY: 'invalid' }));
  assert.throws(() => loadConfig({ RELIQUARY_ENABLE_WRITES: 'yes' }));
  assert.throws(() => loadConfig({ RELIQUARY_TRANSPORT: 'http', RELIQUARY_MCP_TOKEN: key, RELIQUARY_RESOURCES_KEY: key }));
  assert.throws(() => loadConfig({ RELIQUARY_TRANSPORT: 'http', RELIQUARY_MCP_TOKEN: 'a'.repeat(32), RELIQUARY_HTTP_HOST: '0.0.0.0' }));
  assert.equal(loadConfig({}).enableWrites, false);
  assert.equal(loadConfig({ RELIQUARY_API_URL: 'http://127.0.0.1:1234', RELIQUARY_ALLOW_LOCAL_HTTP: 'true' }).apiUrl, 'http://127.0.0.1:1234');
});
test('credential routing, no public credential, strict route and write guards', async () => {
  const calls = [];
  const api = new ApiClient(config, async (url, init) => { calls.push({ url, init }); return Response.json({ ok: true }); });
  await api.request({ path: '/api/resources', scope: 'resources' });
  await api.request({ path: '/api/catalog' });
  assert.equal(calls[0].init.headers.get('Authorization'), `Bearer ${key}`);
  assert.equal(calls[1].init.headers.get('Authorization'), null);
  assert.equal(calls[0].init.redirect, 'manual');
  for (const path of ['//foreign.example/api/resources', 'https://foreign.example/api/resources', '/api/internal/tasks', '/api/admin/finance']) {
    await assert.rejects(api.request({ path }), { code: 'invalid_route' });
  }
  await assert.rejects(api.request({ path: '/api/v1/tasks', scope: 'training' }), { code: 'credential_required' });
  await assert.rejects(new ApiClient(loadConfig({})).request({ path: '/api/resources', method: 'POST' }), { code: 'writes_disabled' });
});
test('bounded reads, safe backend errors and ambiguous mutations', async () => {
  const api = response => new ApiClient(config, async () => response);
  await assert.rejects(api(new Response('x'.repeat(4 * 1024 * 1024 + 1))).request({ path: '/api/catalog' }), { code: 'response_too_large' });
  await assert.rejects(api(new Response('x'.repeat(256 * 1024 + 1))).request({ path: '/api/resources', download: true }), { code: 'response_too_large' });
  await assert.rejects(api(new Response(null, { status: 302, headers: { Location: 'https://foreign.example' } })).request({ path: '/api/resources' }), { code: 'redirect_refused' });
  const download = await api(new Response('hello', { status: 206, headers: { 'Content-Range': 'bytes 0-4/5' } })).request({ path: '/api/resources', download: true });
  assert.equal(download.data, Buffer.from('hello').toString('base64'));
  const reject = new ApiClient(config, async () => { throw new Error('private secret value'); });
  await assert.rejects(reject.request({ path: '/api/resources', method: 'POST', headers: { 'Idempotency-Key': 'retry-key-12345678' }, json: {} }), { code: 'outcome_unknown', retryKey: 'retry-key-12345678' });
  await assert.rejects(api(new Response('not-json')).request({ path: '/api/resources', method: 'POST' }), { code: 'outcome_unknown' });
  await assert.rejects(api(Response.json({ error: { code: 'internal_error' } }, { status: 500 })).request({ path: '/api/resources', method: 'POST', headers: { 'Idempotency-Key': 'retry-key-12345678' } }), { code: 'outcome_unknown', status: 500, retryKey: 'retry-key-12345678' });
  await assert.rejects(api(new Response('x'.repeat(4 * 1024 * 1024 + 1))).request({ path: '/api/resources', method: 'POST', headers: { 'Idempotency-Key': 'retry-key-12345678' } }), { code: 'outcome_unknown', retryKey: 'retry-key-12345678' });
  await assert.rejects(api(Response.json({ error: { code: 'permission_required', message: 'private detail' } }, { status: 403 })).request({ path: '/api/resources' }), error => error.code === 'permission_required' && !error.message.includes('private detail'));
});
