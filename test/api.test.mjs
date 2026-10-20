import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../dist/config.js';
import { ApiClient } from '../dist/api.js';

const key = 'rlq_' + '1'.repeat(48);
const config = loadConfig({ RELIQUARY_RESOURCES_KEY: key, RELIQUARY_ENABLE_WRITES: 'true' });
test('safe refusal diagnostics reach callers without retrying or exposing raw errors', async () => {
  let calls = 0;
  const api = new ApiClient(config, async () => {
    calls++;
    return Response.json({ error: { code: 'rate_limited', message: 'private upstream detail' } }, {
      status: 429, headers: { 'X-Request-ID': 'request-123', 'Retry-After': '17' },
    });
  });
  await assert.rejects(api.request({ path: '/api/resources', scope: 'resources' }), error =>
    error.code === 'rate_limited' && error.requestId === 'request-123' && error.retryAfterSeconds === 17 &&
    !error.message.includes('private upstream detail'));
  assert.equal(calls, 1);
  const invalid = new ApiClient(config, async () => Response.json({ error: { code: 'rate_limited' } }, {
    status: 429, headers: { 'X-Request-ID': '<unsafe>', 'Retry-After': '999999999' },
  }));
  await assert.rejects(invalid.request({ path: '/api/resources', scope: 'resources' }), error =>
    error.requestId === undefined && error.retryAfterSeconds === undefined);
});
test('configuration rejects unsafe origins and invalid credentials', () => {
  for (const url of ['http://example.com', 'https://u:p@example.com', 'https://example.com/path', 'https://example.com?x=1']) {
    assert.throws(() => loadConfig({ RELIQUARY_API_URL: url }));
  }
  assert.throws(() => loadConfig({ RELIQUARY_RESOURCES_KEY: 'invalid' }));
  assert.throws(() => loadConfig({ RELIQUARY_ENABLE_WRITES: 'yes' }));
  assert.throws(() => loadConfig({ RELIQUARY_TRANSPORT: 'http', RELIQUARY_MCP_TOKEN: key, RELIQUARY_RESOURCES_KEY: key }));
  assert.throws(() => loadConfig({ RELIQUARY_TRANSPORT: 'http', RELIQUARY_MCP_TOKEN: 'a'.repeat(32), RELIQUARY_HTTP_HOST: '0.0.0.0' }));
  assert.equal(loadConfig({}).enableWrites, false);
  assert.equal(loadConfig({}).apiUrl, 'https://api.reliqua.ai');
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

test('request admission is bounded across clients and released after completion', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const pending = Array.from({ length: 32 }, () => new ApiClient(config, async () => { await held; return Response.json({ ok: true }); }).request({ path: '/api/catalog' }));
  await assert.rejects(new ApiClient(config).request({ path: '/api/catalog' }), { code: 'server_busy' });
  release();
  await Promise.all(pending);
  const result = await new ApiClient(config, async () => Response.json({ ok: true })).request({ path: '/api/catalog' });
  assert.equal(result.ok, true);
});

test('downloads verify the requested range, byte count and response diagnostics', async () => {
  const input = { path: '/api/resources', download: true, headers: { Range: 'bytes=10-14' } };
  const api = (body, status, contentRange) => new ApiClient(config, async (_url, init) => {
    assert.equal(init.headers.get('Range'), 'bytes=10-14');
    return new Response(body, { status, headers: { 'X-Request-ID': 'range-request-1', 'Retry-After': '5',
      ...(contentRange === undefined ? {} : { 'Content-Range': contentRange }) } });
  });
  const valid = await api('hello', 206, 'bytes 10-14/100').request(input);
  assert.equal(valid.bytes, 5);
  assert.equal(valid.contentRange, 'bytes 10-14/100');
  assert.equal((await api('end', 206, 'bytes 10-12/13').request(input)).bytes, 3);
  for (const [body, status, contentRange] of [
    ['hello', 200], ['hello', 201], ['hello', 206],
    ['hello', 206, 'bytes 0-4/100'], ['hello', 206, 'bytes 10-14/*'],
    ['hello', 206, 'bytes 10-14/14'], ['hello', 206, 'bytes 10-13/100'],
    ['hello', 206, 'bytes 10-15/100'], ['hello', 206, 'bytes 10-14/9007199254740992'],
  ]) {
    await assert.rejects(api(body, status, contentRange).request(input), error =>
      error.code === 'invalid_file_range' && error.status === status && error.requestId === 'range-request-1' && error.retryAfterSeconds === 5);
  }
  await assert.rejects(api('longer', 206, 'bytes 10-15/100').request(input), error =>
    error.code === 'response_too_large' && error.requestId === 'range-request-1');
  const full = new ApiClient(config, async () => new Response('small'));
  assert.equal((await full.request({ ...input, headers: { Range: 'bytes=0-4' } })).bytes, 5);
  await assert.rejects(full.request({ ...input, headers: { Range: 'bytes=0-3' } }), { code: 'response_too_large' });
  for (const value of ['bytes=0-', 'bytes=0-1,4-5', 'bytes=0-262144', 'bytes=2-1', 'bytes=-1-4']) {
    await assert.rejects(full.request({ ...input, headers: { Range: value } }), { code: 'invalid_file_range' });
  }
});
