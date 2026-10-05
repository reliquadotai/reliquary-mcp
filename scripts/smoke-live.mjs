import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// Only public reads; never inherit production credentials or enable writes.
const transport = new StdioClientTransport({
  command: process.execPath, args: ['dist/index.js'],
  env: { RELIQUARY_API_URL: process.env.RELIQUARY_API_URL ?? 'https://app.reliqua.ai' },
  stderr: 'pipe',
});
const client = new Client({ name: 'read-only-smoke', version: '1.0.0' });
try {
  await client.connect(transport);
  for (const name of ['reliquary_readiness', 'reliquary_catalog', 'reliquary_generation_catalog', 'reliquary_evaluation_catalog']) {
    const result = await client.callTool({ name, arguments: {} });
    assert(!result.isError, `${name} failed`);
    assert(result.structuredContent?.data);
    // Print operation/result status only; never persist customer or raw evidence.
    process.stdout.write(`${name}: passed\n`);
  }
} finally { await client.close(); }
