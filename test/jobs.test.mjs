import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { jobRequests } from '@reliquary/api/jobs';
import { operations } from '../dist/tools.js';
import { ApiClient } from '../dist/api.js';
import { loadConfig } from '../dist/config.js';
import { buildServer } from '../dist/server.js';

const uuid = '11111111-1111-4111-8111-111111111111';
const unit = '22222222-2222-4222-8222-222222222222';
const attempt = '33333333-3333-4333-8333-333333333333';
const requestKey = '44444444-4444-4444-8444-444444444444';
const now = 1800000000000;
const id = 'cpu:' + uuid;
const credential = 'rlq_' + '1'.repeat(48);
const digest = value => createHash('sha256').update(value).digest('hex');
const content = '{"text":"Example dataset"}\n';
const input = { dataset_id: uuid, sha256: digest(content), size_bytes: Buffer.byteLength(content), format: 'corpus' };
const spec = { kind: 'dataset_validation', input, limits: { deadline_seconds: 300, max_attempts: 2 } };
const job = { schema_version: 1, id, kind: 'dataset_validation', source_ref: { type: 'dataset_validation', id: uuid }, state: 'queued', native_phase: null, revision: '1', spec_sha256: digest(JSON.stringify(spec)), spec,
  current_attempt_id: null, work_units: [{ id: unit, job_id: id, state: 'queued', attempt_ids: [], artifact_ids: [] }], attempts: [], artifacts: [], created_at: now, updated_at: now, finished_at: null };
const caps = { schema_version: 1, workloads: [{ kind: 'dataset_validation', input_formats: ['instruction', 'preference', 'corpus'], execution: 'cpu', attempts_supported: true, controls: ['pause', 'resume', 'cancel'], can_submit: true, reason: null,
  enrolled_workers: 0, live_workers: 0, qualified_workers: 0, queued_jobs: 1, running_jobs: 0, oldest_queued_at: now }] };
const op = name => { const value = operations.find(o => o.name === 'reliquary_' + name); assert(value, name); return value; };
const config = loadConfig({ RELIQUARY_RESOURCES_KEY: credential, RELIQUARY_ENABLE_WRITES: 'true' });
const shared = jobRequests('key');

test('job tools use the shared key protocol and require exact approval and bounded pinned input', () => {
  const cases = [
    ['jobs_capabilities', {}, shared.capabilities()], ['jobs_list', { limit: 25 }, shared.list({ limit: 25 })],
    ['job_get', { id }, shared.detail(id)], ['job_events', { id, cursor: 'opaque_cursor' }, shared.events(id, { cursor: 'opaque_cursor' })],
    ['job_report', { id, artifactId: 'report-a' }, shared.artifact(id, 'report-a')],
    ['job_input_upload', { format: 'corpus', content, idempotencyKey: requestKey, rightsConfirmed: true, approveExecution: true }, shared.uploadInput({ schema_version: 1, format: 'corpus', content }, requestKey)],
    ['job_submit', { spec, idempotencyKey: requestKey, approveExecution: true }, shared.create({ schema_version: 1, spec }, requestKey)],
    ['job_control', { id, action: 'pause', revision: '1', reason: 'Reviewed pause.', idempotencyKey: requestKey, approveExecution: true }, shared.control(id, 'pause', { schema_version: 1, revision: '1', reason: 'Reviewed pause.' }, requestKey)],
  ];
  for (const [name, args, expected] of cases) {
    const { scope, jobCall, ...descriptor } = op(name).build(args);
    assert.equal(scope, 'resources'); assert(jobCall); assert.deepEqual(descriptor, expected);
    if (op(name).write) {
      assert.throws(() => op(name).build({ ...args, approveExecution: false }));
      assert.throws(() => op(name).build({ ...args, idempotencyKey: 'new-key' }));
    }
  }
  assert.throws(() => op('job_input_upload').build({ format: 'corpus', content, idempotencyKey: requestKey, rightsConfirmed: false, approveExecution: true }));
  assert.throws(() => op('job_input_upload').build({ format: 'corpus', content: 'é'.repeat(16385), idempotencyKey: requestKey, rightsConfirmed: true, approveExecution: true }));
  assert.throws(() => op('job_get').build({ id: 'subnet:' + uuid }));
  assert.throws(() => op('job_get').build({ id: '../private' }));
  assert.throws(() => op('jobs_list').build({ cursor: '../key' }));
  assert.throws(() => op('job_submit').build({ spec: { ...spec, kind: 'corpus_generation' }, idempotencyKey: requestKey, approveExecution: true }));
});

test('shared job response validation preserves unknown mutation keys and reviewed revisions', async () => {
  const create = op('job_submit').build({ spec, idempotencyKey: requestKey, approveExecution: true });
  const control = op('job_control').build({ id, action: 'cancel', revision: '7', reason: 'Reviewed cancellation.', idempotencyKey: requestKey, approveExecution: true });
  let count = 0;
  const bad = new ApiClient(config, async () => { count++; return Response.json({}); });
  await assert.rejects(bad.request(create), e => e.code === 'outcome_unknown' && e.retryKey === requestKey);
  await assert.rejects(bad.request(control), e => e.code === 'outcome_unknown' && e.retryKey === requestKey && e.revision === '7');
  assert.equal(count, 2);
  const forbidden = new ApiClient(config, async () => Response.json({ error: { code: 'permission_required' } }, { status: 403 }));
  await assert.rejects(forbidden.request(create), e => e.code === 'permission_required' && e.status === 403);
  const disabled = new ApiClient(loadConfig({ RELIQUARY_RESOURCES_KEY: credential }), async () => { throw new Error('Should not send.'); });
  await assert.rejects(disabled.request(create), e => e.code === 'writes_disabled');
  const wrongInput = new ApiClient(config, async () => Response.json({ schema_version: 1, input: { ...input, sha256: 'a'.repeat(64) } }));
  await assert.rejects(wrongInput.request(op('job_input_upload').build({ format: 'corpus', content, idempotencyKey: requestKey, rightsConfirmed: true, approveExecution: true })), e => e.code === 'outcome_unknown' && e.retryKey === requestKey);
  const wrongJob = new ApiClient(config, async () => Response.json({ schema_version: 1, job: { ...job, source_ref: { ...job.source_ref, id: attempt } } }));
  await assert.rejects(wrongJob.request(op('job_get').build({ id })), e => e.code === 'invalid_response');
});

test('job discovery keeps writes disabled and never exposes operator or worker authority', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer(loadConfig({ RELIQUARY_RESOURCES_KEY: credential }));
  const client = new Client({ name: 'job-discovery-test', version: '1.0.0' });
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    assert(tools.some(t => t.name === 'reliquary_jobs_capabilities'));
    assert(tools.some(t => t.name === 'reliquary_job_report'));
    for (const name of ['job_submit', 'job_input_upload', 'job_control', 'training_start']) assert(!tools.some(t => t.name === 'reliquary_' + name));
    assert(!tools.some(t => /worker|operator|native/.test(t.name)));
    assert(tools.every(t => t.annotations.readOnlyHint));
  } finally { await client.close(); await server.close(); }
});

test('real stdio MCP job flow preserves wire bytes, owner scope, report integrity and uncertain control', async () => {
  const seen = [];
  const report = { schema_version: 1, input_sha256: input.sha256, format: 'corpus', rows: 1, valid: true, errors: [] };
  const artifact = { id: 'report-a', job_id: id, work_unit_id: unit, attempt_id: attempt, kind: 'validation_report', name: 'validation.json', size_bytes: Buffer.byteLength(JSON.stringify(report)), sha256: digest(JSON.stringify(report)), content_type: 'application/json', created_at: now };
  const backend = createServer(async (request, response) => {
    let body = ''; for await (const bytes of request) body += bytes;
    seen.push({ path: request.url, method: request.method, headers: request.headers, body });
    let data;
    if (request.url.endsWith('/capabilities')) data = caps;
    else if (request.url === '/api/v1/job-inputs') {
      const upload = JSON.parse(body); data = { schema_version: 1, input: { ...input, sha256: digest(upload.content), size_bytes: Buffer.byteLength(upload.content) } };
    } else if (request.url.endsWith('/events')) data = { schema_version: 1, events: [], next_cursor: null };
    else if (request.url.endsWith('/artifacts/report-a')) data = { schema_version: 1, artifact, report };
    else if (request.url.endsWith('/cancel')) { data = { error: { code: 'internal_error' } }; response.statusCode = 503; response.setHeader('X-Request-ID', 'request-123'); }
    else if (request.url === '/api/v1/jobs' && request.method === 'GET') data = { schema_version: 1, jobs: [job], next_cursor: null };
    else data = { schema_version: 1, job };
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(data));
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'], env: {
    RELIQUARY_API_URL: `http://127.0.0.1:${backend.address().port}`, RELIQUARY_ALLOW_LOCAL_HTTP: 'true', RELIQUARY_ENABLE_WRITES: 'true', RELIQUARY_RESOURCES_KEY: credential,
  }, stderr: 'pipe' });
  const client = new Client({ name: 'job-protocol-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const call = (name, args = {}) => client.callTool({ name: 'reliquary_' + name, arguments: args });
    assert.equal((await call('jobs_capabilities')).structuredContent.data.workloads[0].qualified_workers, 0);
    const denied = await call('job_submit', { spec, idempotencyKey: requestKey, approveExecution: false }); assert(denied.isError); assert.equal(seen.length, 1);
    const upload = await call('job_input_upload', { format: 'corpus', content, idempotencyKey: requestKey, rightsConfirmed: true, approveExecution: true });
    assert.deepEqual(upload.structuredContent.data.input, input);
    const boundary = '\n'.repeat(32768);
    await call('job_input_upload', { format: 'corpus', content: boundary, idempotencyKey: requestKey, rightsConfirmed: true, approveExecution: true });
    assert.equal(JSON.parse(seen.at(-1).body).content.length, 32768);
    assert.deepEqual((await call('job_submit', { spec, idempotencyKey: requestKey, approveExecution: true })).structuredContent.data.job, job);
    assert.deepEqual((await call('jobs_list')).structuredContent.data.jobs, [job]);
    assert.deepEqual((await call('job_get', { id })).structuredContent.data.job, job);
    assert.deepEqual((await call('job_events', { id })).structuredContent.data.events, []);
    assert.deepEqual((await call('job_report', { id, artifactId: 'report-a' })).structuredContent.data.report, report);
    const unknown = await call('job_control', { id, action: 'cancel', revision: '1', reason: 'Reviewed cancellation.', idempotencyKey: requestKey, approveExecution: true });
    assert.deepEqual(unknown.structuredContent.data.error, { code: 'outcome_unknown', status: 503, idempotencyKey: requestKey, revision: '1', requestId: 'request-123' });
    assert.equal(seen.filter(r => r.path.endsWith('/cancel')).length, 1);
    assert(seen.every(r => r.headers.authorization === `Bearer ${credential}` && !r.headers.cookie && !r.headers['x-action-proof']));
    assert.equal(seen.at(-1).headers['x-resource-revision'], '1'); assert.equal(seen.at(-1).headers['idempotency-key'], requestKey);
  } finally { await client.close(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); }
});
