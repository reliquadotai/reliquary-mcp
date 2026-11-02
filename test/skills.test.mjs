import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { DEVELOPER_PREVIEW, OFFICIAL_SKILLS, skillInstructionsPath } from '@reliquary/api';
import { loadConfig } from '../dist/config.js';
import { buildServer } from '../dist/server.js';
import { operations } from '../dist/tools.js';
import { batchTools } from '../dist/batch.js';

test('official recipes cover the customer tool registry without inventing tool names', () => {
  const registered = new Set(['reliquary_connection', 'reliquary_skills', ...operations.map(operation => operation.name), ...batchTools.map(tool => tool.name)]);
  const documented = new Set(OFFICIAL_SKILLS.flatMap(skill => skill.mcpTools));
  for (const name of registered) assert(documented.has(name), `Missing official skill coverage for ${name}`);
  for (const name of documented) assert(registered.has(name), `Unknown tool in official skill catalog: ${name}`);
});

test('official skills are discoverable without credentials, upstream calls or write enablement', async () => {
  let calls = 0;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer(loadConfig({}), { request: async () => { calls++; throw new Error('Discovery must stay local.'); } });
  const client = new Client({ name: 'skills-discovery-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    const tool = tools.find(tool => tool.name === 'reliquary_skills');
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert(tools.every(tool => tool.annotations.readOnlyHint));
    const connection = (await client.callTool({ name: 'reliquary_connection', arguments: {} })).structuredContent.data;
    assert(connection.tools.includes('reliquary_skills'));
    assert.equal(connection.skills.count, OFFICIAL_SKILLS.length);
    assert.equal(connection.writesEnabled, false);
    const call = async args => (await client.callTool({ name: 'reliquary_skills', arguments: args })).structuredContent.data;
    const all = await call({});
    assert.equal(all.version, DEVELOPER_PREVIEW.version);
    assert.equal(all.total, OFFICIAL_SKILLS.length);
    assert.deepEqual(all.skills.map(skill => skill.id), OFFICIAL_SKILLS.map(skill => skill.id));
    assert(all.skills.some(skill => skill.access === 'approval-required'));
    assert(all.skills.every(skill => skill.docsUrl.startsWith('https://app.reliqua.ai/docs/') &&
      skill.instructionsUrl === new URL(skillInstructionsPath(skill), 'https://app.reliqua.ai').href));
    assert.match(all.notice, /not live execution availability/);
    const selected = OFFICIAL_SKILLS.find(skill => skill.id === 'reliquary-compute');
    const one = await call({ id: selected.id });
    assert.equal(one.count, 1);
    assert.equal(one.skills[0].id, selected.id);
    const category = await call({ category: selected.category });
    assert(category.count > 0);
    assert(category.skills.every(skill => skill.category === selected.category));
    const search = await call({ search: selected.title.toUpperCase() });
    assert(search.skills.some(skill => skill.id === selected.id));
    assert.equal((await call({ id: selected.id, category: 'unknown-category' })).count, 0);
    assert.equal((await call({ id: 'reliquary-unknown-skill' })).count, 0);
    assert((await client.callTool({ name: 'reliquary_skills', arguments: { unexpected: true } })).isError);
    assert((await client.callTool({ name: 'reliquary_skills', arguments: { search: 'x'.repeat(161) } })).isError);
    const resource = await client.readResource({ uri: 'reliquary://skills' });
    const manifest = JSON.parse(resource.contents[0].text);
    assert.equal(manifest.total, OFFICIAL_SKILLS.length);
    assert.deepEqual(manifest.skills, all.skills);
    const prompt = await client.getPrompt({ name: 'reliquary-skill', arguments: { goal: 'Compare compute for my workload' } });
    assert.match(prompt.messages[0].content.text, /reliquary_skills/);
    assert.match(prompt.messages[0].content.text, /not approval to install/);
    assert.match(prompt.messages[0].content.text, /Compare compute for my workload/);
    assert.equal(calls, 0);
  } finally { await client.close(); await server.close(); }
});

test('public run tools keep bounded selectors and never request credential scope or write authority', () => {
  const catalog = operations.find(op => op.name === 'reliquary_run_catalog');
  const monitor = operations.find(op => op.name === 'reliquary_run_monitor');
  for (const op of [catalog, monitor]) { assert.equal(op.scope, undefined); assert.equal(op.write, false); }
  assert.deepEqual(catalog.build({}), { path: '/api/monitoring/runs' });
  assert.deepEqual(monitor.build({}), { path: '/api/monitoring/run' });
  assert.deepEqual(monitor.build({ run: 'published-run' }), { path: '/api/monitoring/run?run=published-run' });
  for (const run of ['', '.', '..', 'x/y', 'x?key=secret', 'x'.repeat(129)]) assert.throws(() => monitor.build({ run }));
  assert.throws(() => catalog.build({ run: 'current' }));
  assert.throws(() => monitor.build({ url: 'https://example.invalid' }));
});
