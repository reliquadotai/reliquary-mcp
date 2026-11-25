import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspect } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { ed25519PairFromSeed, encodeAddress, mnemonicToMiniSecret, sr25519PairFromSeed } from '@polkadot/util-crypto';
import { ApiClient } from '../dist/api.js';
import { loadConfig } from '../dist/config.js';
import { buildServer } from '../dist/server.js';
import { operations } from '../dist/tools.js';
import { DEFAULT_GAMMA_RECEIVER, loadWallet, WalletConfigError } from '../dist/wallet.js';
import { createVerifier, initBody } from './support/btauth-verifier.mjs';

// Test-only key material: a fixed seed and the public development phrase. Never a real hotkey.
const SEED = '0x' + '4b'.repeat(32);
const OTHER_PHRASE = 'bottom drive obey lake curtain smoke basket hold race lonely fit walk';
const seedBytes = Buffer.from(SEED.slice(2), 'hex');
const SR = sr25519PairFromSeed(seedBytes), ED = ed25519PairFromSeed(seedBytes);
const hex = bytes => '0x' + Buffer.from(bytes).toString('hex');
const keyfile = (pair, extra = {}) => ({ accountId: hex(pair.publicKey), publicKey: hex(pair.publicKey), privateKey: hex(pair.secretKey),
  secretSeed: SEED, ss58Address: encodeAddress(pair.publicKey, 42), ...extra });
const secretsOf = data => [SEED.slice(2), SEED.slice(2, 34), OTHER_PHRASE, ...OTHER_PHRASE.split(' ').slice(0, 3).map(w => ` ${w} `), hex(SR.secretKey).slice(2, 34), data?.privateKey?.slice(2, 34)].filter(Boolean);
const assertNoSecret = (text, data) => { for (const secret of secretsOf(data)) assert.ok(!text.includes(secret), `leaked ${secret.slice(0, 6)}…`); };

async function walletDir() {
  const root = await mkdtemp(join(tmpdir(), 'mcp-wallet-'));
  const hotkeys = join(root, 'wallets', 'agent', 'hotkeys');
  await mkdir(hotkeys, { recursive: true });
  const write = async (name, content) => { const path = join(hotkeys, name); await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content)); return path; };
  return { root, hotkeys, write, close: () => rm(root, { recursive: true, force: true }) };
}

async function memory(config, api = new ApiClient(config)) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer(config, api);
  await server.connect(serverTransport);
  const client = new Client({ name: 'wallet-test', version: '1.0.0' });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test('wallet mode loads an sr25519 hotkey from secretSeed and reports only its public identity', async () => {
  const dir = await walletDir();
  try {
    // secretSeed wins over secretPhrase: the phrase here derives another key, and the declared key is the seed's.
    const data = keyfile(SR, { secretPhrase: OTHER_PHRASE });
    const path = await dir.write('reliquary', data);
    const config = loadConfig({ RELIQUARY_HOTKEY_FILE: path });
    assert.equal(config.wallet.signer.ss58, encodeAddress(SR.publicKey, 42));
    assert.equal(config.wallet.signer.scheme, 'sr25519');
    assert.equal(config.wallet.receiver, DEFAULT_GAMMA_RECEIVER);
    assert.deepEqual(config.wallet.btcli, { wallet: 'agent', hotkey: 'reliquary', walletPath: join(dir.root, 'wallets') });
    assertNoSecret(JSON.stringify(config), data);
    assertNoSecret(inspect(config, { depth: 10, showHidden: true }), data);
    const session = await memory(config);
    try {
      const result = await session.client.callTool({ name: 'reliquary_connection', arguments: {} });
      const connection = result.structuredContent.data;
      assert.equal(connection.authentication, 'btauth/1');
      assert.deepEqual({ ...connection.wallet, note: undefined }, { mode: 'btauth/1', hotkey: config.wallet.signer.ss58, crypto: 'sr25519',
        receiver: DEFAULT_GAMMA_RECEIVER, netuid: 81, scopes: 'all', note: undefined });
      assert.deepEqual(connection.credentialScopes, []);
      assertNoSecret(JSON.stringify(result), data);
      assertNoSecret(JSON.stringify(await session.client.listTools()), data);
    } finally { await session.close(); }
  } finally { await dir.close(); }
});

test('wallet mode reads a phrase-only file and recognises an ed25519 hotkey by its declared key', async () => {
  const dir = await walletDir();
  try {
    const root = sr25519PairFromSeed(mnemonicToMiniSecret(OTHER_PHRASE));
    const phraseOnly = await dir.write('phrase', { secretPhrase: `  ${OTHER_PHRASE.replaceAll(' ', '  ')} `, ss58Address: encodeAddress(root.publicKey, 42) });
    assert.equal(loadConfig({ RELIQUARY_HOTKEY_FILE: phraseOnly }).wallet.signer.ss58, encodeAddress(root.publicKey, 42));
    const ed = await dir.write('ed', keyfile(ED));
    const wallet = loadConfig({ RELIQUARY_HOTKEY_FILE: ed }).wallet;
    assert.equal(wallet.signer.scheme, 'ed25519');
    assert.equal(wallet.signer.ss58, encodeAddress(ED.publicKey, 42));
    // Outside the <wallets>/<wallet>/hotkeys/<name> layout no btcli names are guessed.
    const loose = join(dir.root, 'agent-hotkey.json');
    await writeFile(loose, JSON.stringify(keyfile(SR)));
    assert.deepEqual(loadConfig({ RELIQUARY_HOTKEY_FILE: loose }).wallet.btcli, {});
  } finally { await dir.close(); }
});

test('wallet mode is refused over HTTP and for coldkeys, secrets in the environment and unusable files', async () => {
  const dir = await walletDir();
  try {
    const good = await dir.write('reliquary', keyfile(SR));
    const http = { RELIQUARY_TRANSPORT: 'http', RELIQUARY_MCP_TOKEN: 'http_test_token_000000000000000000000' };
    const refused = async (env, pattern) => {
      let error;
      try { loadConfig(env); } catch (caught) { error = caught; }
      assert.ok(error instanceof WalletConfigError, `${JSON.stringify(env)} → ${error}`);
      assert.match(error.message, pattern);
      assertNoSecret(error.message + String(error.stack), keyfile(SR));
    };
    await refused({ ...http, RELIQUARY_HOTKEY_FILE: good }, /stdio only/);
    assert.equal(loadConfig(http).wallet, undefined);
    await mkdir(join(dir.root, 'wallets', 'agent'), { recursive: true });
    const coldkey = join(dir.root, 'wallets', 'agent', 'coldkey');
    await writeFile(coldkey, JSON.stringify(keyfile(SR)));
    await refused({ RELIQUARY_HOTKEY_FILE: coldkey }, /coldkey/);
    for (const name of ['RELIQUARY_HOTKEY_SEED', 'RELIQUARY_COLDKEY', 'RELIQUARY_MNEMONIC', 'RELIQUARY_SECRET_PHRASE', 'RELIQUARY_PRIVATE_KEY']) {
      await refused({ RELIQUARY_HOTKEY_FILE: good, [name]: SEED }, /not accepted in environment/);
      await refused({ [name]: OTHER_PHRASE }, /not accepted in environment/);
    }
    const cases = [
      ['encrypted', '$NACL' + 'x'.repeat(80), /encrypted/],
      ['text', 'secret seed ' + SEED, /not a bittensor keyfile/],
      ['array', [keyfile(SR)], /not a bittensor keyfile/],
      ['mismatch', keyfile(SR, { publicKey: hex(ED.publicKey), accountId: hex(ED.publicKey), ss58Address: encodeAddress(ED.publicKey, 42), secretSeed: '0x' + '4c'.repeat(32) }), /does not hold/],
      ['anonymous', { secretSeed: SEED }, /declares no public key/],
      ['conflict', keyfile(SR, { accountId: hex(ED.publicKey) }), /conflicting/],
      ['badseed', keyfile(SR, { secretSeed: SEED.slice(0, 40) }), /malformed secretSeed/],
      ['badphrase', { secretPhrase: 'not a valid phrase at all', ss58Address: encodeAddress(SR.publicKey, 42) }, /invalid secretPhrase/],
      ['derived', { secretPhrase: OTHER_PHRASE + '//hard', ss58Address: encodeAddress(SR.publicKey, 42) }, /invalid secretPhrase/],
      ['nosecret', { ss58Address: encodeAddress(SR.publicKey, 42), publicKey: hex(SR.publicKey) }, /neither secretSeed nor secretPhrase/],
      ['hashed', keyfile(SR, { ss58Address: encodeAddress(Buffer.alloc(32, 9), 42), publicKey: undefined, accountId: undefined }), /does not hold/],
    ];
    for (const [name, content, pattern] of cases) await refused({ RELIQUARY_HOTKEY_FILE: await dir.write(name, content) }, pattern);
    await refused({ RELIQUARY_HOTKEY_FILE: join(dir.hotkeys, 'missing') }, /not a readable hotkey file/);
    await refused({ RELIQUARY_HOTKEY_FILE: dir.hotkeys }, /not a readable hotkey file/);
    await refused({ RELIQUARY_HOTKEY_FILE: await dir.write('huge', JSON.stringify({ ...keyfile(SR), pad: 'x'.repeat(70_000) })) }, /not a readable hotkey file/);
    await refused({ RELIQUARY_HOTKEY_FILE: good, RELIQUARY_GAMMA_RECEIVER: '0x' + '11'.repeat(32) }, /RELIQUARY_GAMMA_RECEIVER/);
    await refused({ RELIQUARY_GAMMA_RECEIVER: 'not-an-address' }, /RELIQUARY_GAMMA_RECEIVER/);
    assert.equal(loadWallet({}, 'stdio'), undefined);
  } finally { await dir.close(); }
});

test('the server process refuses wallet mode over HTTP with a safe message', { timeout: 30_000 }, async () => {
  const dir = await walletDir();
  try {
    const path = await dir.write('reliquary', keyfile(SR));
    const child = spawn(process.execPath, [resolve(import.meta.dirname, '..', 'dist', 'index.js')], {
      env: { PATH: process.env.PATH, RELIQUARY_TRANSPORT: 'http', RELIQUARY_MCP_TOKEN: 'http_test_token_000000000000000000000', RELIQUARY_HOTKEY_FILE: path },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    // A server that wrongly starts would listen forever: stop it so the test fails instead of hanging.
    const timer = setTimeout(() => child.kill(), 10_000);
    const code = await new Promise(done => child.on('close', done)).finally(() => clearTimeout(timer));
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /Wallet mode runs over stdio only/);
    assertNoSecret(stderr, keyfile(SR));
  } finally { await dir.close(); }
});

test('wallet mode signs every scope with btauth/1, never sends a bearer key, and leaves public reads unsigned', async () => {
  const dir = await walletDir();
  try {
    const config = loadConfig({ RELIQUARY_HOTKEY_FILE: await dir.write('reliquary', keyfile(SR)), RELIQUARY_ENABLE_WRITES: 'true' });
    const verify = createVerifier({ receiver: DEFAULT_GAMMA_RECEIVER });
    const seen = [];
    const api = new ApiClient(config, async (url, init) => {
      const headers = new Headers(init.headers);
      assert.equal(headers.get('Authorization'), null);
      const signed = headers.has('X-Bittensor-Signature');
      const caller = signed ? await verify({ method: init.method, url: url.href, headers }, initBody(init)) : null;
      seen.push({ path: url.pathname, method: init.method, caller });
      return Response.json(url.pathname.endsWith('/capabilities') ? { schema_version: 1, workloads: [{ kind: 'dataset_validation', input_formats: ['instruction', 'preference', 'corpus'],
        execution: 'cpu', attempts_supported: true, controls: ['pause', 'resume', 'cancel'], can_submit: true, reason: null, enrolled_workers: 0, live_workers: 0,
        qualified_workers: 0, queued_jobs: 0, running_jobs: 0, oldest_queued_at: null }] } : { ok: true });
    });
    const op = name => operations.find(o => o.name === 'reliquary_' + name);
    for (const [name, args] of [['resources_list', {}], ['generation_balance', {}], ['evaluation_balance', {}], ['training_balance', {}],
      ['resource_create', { kind: 'training', name: 'Draft', config: { schemaVersion: 2 }, idempotencyKey: 'stable_request_key_123456' }]]) {
      await api.request(op(name).build(args));
      assert.equal(seen.at(-1).caller?.hotkey, config.wallet.signer.ss58, name);
    }
    assert.deepEqual(new Set(['resources', 'orders', 'evaluations', 'training']), new Set(['resources_list', 'generation_balance', 'evaluation_balance', 'training_balance'].map(n => op(n).scope)));
    assert.equal(seen.at(-1).method, 'POST');
    await api.request(op('catalog').build({}));
    assert.equal(seen.at(-1).caller, null, 'public reads carry no signature');
    await api.request({ path: '/api/v1/balance', scope: 'orders' });
    await api.request({ path: '/api/v1/balance', scope: 'orders' });
    assert.notEqual(seen.at(-1).caller.nonce, seen.at(-2).caller.nonce, 'each attempt is signed afresh');
    const session = await memory(config, api);
    try {
      const names = (await session.client.listTools()).tools.map(tool => tool.name);
      for (const name of ['reliquary_resources_list', 'reliquary_training_balance', 'reliquary_generation_order', 'reliquary_batch_upload', 'reliquary_batch_files',
        'reliquary_gamma_balance', 'reliquary_gamma_fund_plan', 'bittensor_services', 'bittensor_call']) assert.ok(names.includes(name), name);
      const read = await session.client.callTool({ name: 'reliquary_jobs_capabilities', arguments: {} });
      assert.equal(read.isError, undefined, JSON.stringify(read));
      assert.equal(seen.at(-1).caller.hotkey, config.wallet.signer.ss58);
    } finally { await session.close(); }
    const readOnly = await memory(loadConfig({ RELIQUARY_HOTKEY_FILE: await dir.write('reader', keyfile(SR)) }));
    try {
      const names = (await readOnly.client.listTools()).tools.map(tool => tool.name);
      assert.ok(names.includes('reliquary_resources_list') && !names.includes('reliquary_generation_order') && !names.includes('bittensor_call'));
    } finally { await readOnly.close(); }
  } finally { await dir.close(); }
});

test('batch upload and download are signed through the packaged transport in wallet mode', async () => {
  const dir = await walletDir();
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const output = Buffer.from('{"id":"r1","custom_id":"a","response":{"status_code":200},"error":null}\n'.repeat(20));
  const verify = createVerifier({ receiver: DEFAULT_GAMMA_RECEIVER, maxBodyBytes: 5 * 1024 * 1024 });
  const files = new Map(), callers = [];
  const order = { model: 'org/model', revision: 'a'.repeat(40), input_file_id: 'file-1', prompt_count: 1, samples_per_prompt: 1, max_new_tokens: 64,
    sampling: { temperature: 1, top_p: 1, top_k: 0 }, id: 'order-1', status: 'delivered', price_usd: 1, cancel_requested: false, status_reason: null,
    needs_attention: false, progress: null, created_at: '2030-01-01T00:00:00Z', updated_at: '2030-01-01T00:00:00Z', finished_at: null, refunded_usd: 0,
    deliveries: [{ delivery_id: 'dl-1', files: [{ name: 'output-00000.jsonl', size: output.length, sha256: sha(output), url: '/api/v1/dataset-orders/order-1/deliveries/dl-1/files/output-00000.jsonl' }] }] };
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', async () => {
      const body = Buffer.concat(chunks);
      const json = (status, value) => { response.statusCode = status; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
      try {
        assert.equal(request.headers.authorization, undefined);
        callers.push(await verify({ method: request.method, url: `http://127.0.0.1:${server.address().port}${request.url}`, headers: request.headers }, new Uint8Array(body)));
      } catch (error) { return json(401, { error: { code: error.code ?? 'unsigned' } }); }
      let m;
      if (request.method === 'POST' && request.url === '/api/v1/files') {
        const input = JSON.parse(body);
        files.set('file-1', { ...input, parts: [] });
        return json(201, { id: 'file-1', object: 'file', bytes: input.bytes, filename: input.filename, purpose: 'batch', status: 'uploading',
          created_at: '2030-01-01T00:00:00Z', upload: { part_size: 1024, parts: Math.ceil(input.bytes / 1024) } });
      }
      if ((m = request.url.match(/^\/api\/v1\/files\/file-1\/parts\/(\d+)$/))) { files.get('file-1').parts[Number(m[1]) - 1] = body; return json(200, { part: Number(m[1]), etag: 'e' }); }
      if (request.url === '/api/v1/files/file-1/complete') {
        const file = files.get('file-1');
        file.content = Buffer.concat(file.parts);
        return json(200, { id: 'file-1', object: 'file', bytes: file.bytes, filename: file.filename, purpose: 'batch', status: 'processed', created_at: '2030-01-01T00:00:00Z' });
      }
      if (request.url === '/api/v1/dataset-orders/order-1') return json(200, { order });
      if (request.url === '/api/v1/dataset-orders/order-1/deliveries/dl-1/files/output-00000.jsonl') { response.setHeader('Content-Length', String(output.length)); return response.end(output); }
      return json(404, { error: { code: 'not_found' } });
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const config = loadConfig({ RELIQUARY_HOTKEY_FILE: await dir.write('reliquary', keyfile(SR)), RELIQUARY_ENABLE_WRITES: 'true',
      RELIQUARY_ALLOW_LOCAL_HTTP: 'true', RELIQUARY_API_URL: `http://127.0.0.1:${server.address().port}` });
    const session = await memory(config);
    try {
      const input = Buffer.from('{"custom_id":"x","method":"POST","url":"/v1/chat/completions","body":{}}\n'.repeat(60));
      await writeFile(join(dir.root, 'requests.jsonl'), input);
      const uploaded = await session.client.callTool({ name: 'reliquary_batch_upload', arguments: { path: join(dir.root, 'requests.jsonl'), rightsConfirmed: true, approveExecution: true } });
      assert.equal(uploaded.isError, undefined, JSON.stringify(uploaded));
      assert.deepEqual(files.get('file-1').content, input);
      const saved = await session.client.callTool({ name: 'reliquary_batch_download', arguments: { orderId: 'order-1', directory: join(dir.root, 'out') } });
      assert.equal(saved.isError, undefined, JSON.stringify(saved));
      assert.deepEqual(await readFile(join(dir.root, 'out', 'dl-1', 'output-00000.jsonl')), output);
      assert.ok(callers.length >= 6);
      assert.ok(callers.every(caller => caller.hotkey === config.wallet.signer.ss58));
    } finally { await session.close(); }
  } finally { await new Promise(done => server.close(done)); await dir.close(); }
});

test('a flat Gamma refusal keeps its code, so a signed order without balance reports insufficient_balance', async () => {
  const dir = await walletDir();
  try {
    const config = loadConfig({ RELIQUARY_HOTKEY_FILE: await dir.write('reliquary', keyfile(SR)), RELIQUARY_ENABLE_WRITES: 'true' });
    let reply;
    const api = new ApiClient(config, async () => reply());
    const order = { path: '/api/v1/dataset-orders', method: 'POST', scope: 'orders', json: { quote_id: 'quote-1' }, headers: { 'Idempotency-Key': 'stable_request_key_123456' } };
    const outcome = async request => { try { await api.request(request); return 'ok'; } catch (error) { return [error.code, error.status]; } };
    const cases = [
      [{ error: 'insufficient_balance' }, 402, order, ['insufficient_balance', 402]],
      [{ error: { code: 'insufficient_balance' } }, 402, order, ['insufficient_balance', 402]],
      [{ error: 'stale_request' }, 401, { path: '/api/v1/balance', scope: 'orders' }, ['stale_request', 401]],
      [{ error: 'Not a code' }, 402, order, ['http_402', 402]],
      // A server failure after a mutation stays an unknown outcome, whatever its body says.
      [{ error: 'insufficient_balance' }, 503, order, ['outcome_unknown', 503]],
      [{ error: 'insufficient_balance' }, 408, order, ['outcome_unknown', 408]],
    ];
    for (const [body, status, request, expected] of cases) {
      reply = () => Response.json(body, { status });
      assert.deepEqual(await outcome(request), expected, JSON.stringify([body, status]));
    }
    const session = await memory(config, api);
    try {
      reply = () => Response.json({ error: 'insufficient_balance' }, { status: 402 });
      const result = await session.client.callTool({ name: 'reliquary_batch_order', arguments: { quoteId: 'quote-1', idempotencyKey: 'stable_request_key_123456', approveExecution: true } });
      assert.equal(result.isError, true);
      assert.deepEqual([result.structuredContent.data.error.code, result.structuredContent.data.error.status], ['insufficient_balance', 402]);
    } finally { await session.close(); }
  } finally { await dir.close(); }
});
