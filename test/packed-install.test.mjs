import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { OFFICIAL_SKILLS } from '@reliquary/api';

const run = (args, cwd) => new Promise((resolve, reject) => {
  const child = spawn('npm', args, { cwd });
  let out = '', err = '';
  child.stdout.on('data', data => { out += data; });
  child.stderr.on('data', data => { err += data; });
  child.on('error', reject);
  child.on('close', code => resolve({ code, out, err }));
});
test('pinned tarball installs without private repository access and exposes read-only stdio tools', { timeout: 90_000 }, async () => {
  const root = resolve(import.meta.dirname, '..');
  const temp = await mkdtemp(join(tmpdir(), 'mcp-package-'));
  let transport;
  try {
    const packed = await run(['pack', '--ignore-scripts', '--json', '--pack-destination', temp], root);
    assert.equal(packed.code, 0, packed.err);
    const name = JSON.parse(packed.out)[0].filename;
    const install = await run(['install', '--prefix', join(temp, 'install'), '--ignore-scripts', '--no-audit', '--no-fund', join(temp, name)], temp);
    assert.equal(install.code, 0, install.err);
    const installedRoot = join(temp, 'install/node_modules/@reliquary/mcp');
    const installedRequire = createRequire(join(installedRoot, 'package.json'));
    const adapterEntry = installedRequire.resolve('@hono/node-server');
    const adapter = JSON.parse(await readFile(resolve(dirname(adapterEntry), '..', 'package.json'), 'utf8'));
    const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
    assert.equal(adapter.version, lock.packages['node_modules/@hono/node-server'].version,
      'Packed installation must retain the reviewed runtime dependency closure.');
    transport = new StdioClientTransport({ command: process.execPath,
      args: [join(temp, 'install/node_modules/@reliquary/mcp/dist/index.js')],
      env: { PATH: process.env.PATH, RELIQUARY_ENABLE_WRITES: 'false' }, stderr: 'pipe' });
    const client = new Client({ name: 'package-verification', version: '1.0.0' });
    await client.connect(transport);
    const result = await client.callTool({ name: 'reliquary_connection', arguments: {} });
    const connection = result.structuredContent.data;
    assert.equal(connection.version, '0.12.0');
    assert.equal(connection.writesEnabled, false);
    assert.deepEqual(connection.credentialScopes, []);
    assert.ok(connection.tools.includes('reliquary_compute_catalog'));
    assert.ok(connection.tools.includes('reliquary_skills'));
    assert.ok(!connection.tools.includes('reliquary_training_start'));
    assert.ok(!connection.tools.includes('reliquary_job_submit'));
    const skills = await client.callTool({ name: 'reliquary_skills', arguments: {} });
    assert.deepEqual(skills.structuredContent.data.skills.map(skill => skill.id), OFFICIAL_SKILLS.map(skill => skill.id));
    const resource = await client.readResource({ uri: 'reliquary://skills' });
    assert.equal(JSON.parse(resource.contents[0].text).version, '0.12.0');
    await client.close();
  } finally { await transport?.close(); await rm(temp, { recursive: true, force: true }); }
});
