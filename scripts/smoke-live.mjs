import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// Only public reads; never inherit production credentials or enable writes.
const transport = new StdioClientTransport({
  command: process.execPath, args: ['dist/index.js'],
  env: process.env.RELIQUARY_API_URL ? { RELIQUARY_API_URL: process.env.RELIQUARY_API_URL } : {},
  stderr: 'pipe',
});
const client = new Client({ name: 'read-only-smoke', version: '1.0.0' });
try {
  await client.connect(transport);
  const connection = await client.callTool({ name: 'reliquary_connection', arguments: {} });
  assert.equal(connection.structuredContent?.data.writesEnabled, false);
  assert.deepEqual(connection.structuredContent?.data.credentialScopes, []);
  const skills = await client.callTool({ name: 'reliquary_skills', arguments: {} });
  assert(!skills.isError);
  assert.equal(skills.structuredContent?.data.count, connection.structuredContent.data.skills.count);
  process.stdout.write(`Public API: ${connection.structuredContent.data.apiOrigin}\n`);
  process.stdout.write('reliquary_skills: passed\n');
  for (const name of ['reliquary_run_catalog', 'reliquary_run_monitor', 'reliquary_health', 'reliquary_readiness', 'reliquary_catalog', 'reliquary_generation_catalog', 'reliquary_evaluation_catalog']) {
    const result = await client.callTool({ name, arguments: {} });
    assert(!result.isError, `${name} failed`);
    assert(result.structuredContent?.data);
    // Print operation/result status only; never persist customer or raw evidence.
    process.stdout.write(`${name}: passed\n`);
  }
} finally { await client.close(); }
