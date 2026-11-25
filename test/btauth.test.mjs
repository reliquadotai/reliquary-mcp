import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { inspect } from 'node:util';
import { ed25519PairFromSeed, encodeAddress, keyExtractPath, keyFromPath, mnemonicToMiniSecret, sr25519PairFromSeed } from '@polkadot/util-crypto';
import { btauthPayload, freshNonce, HotkeySigner, requestTarget, sha256Hex, signRequest } from '../dist/btauth.js';
import { BtauthRejected, createVerifier } from './support/btauth-verifier.mjs';

// Golden vectors from https://www.bittensor.com/docs/guides/signed-requests: sender //Alice, receiver //Bob,
// nonce 1752076800000000000, body {"prompt": "hello"}, request POST /generate?stream=false.
const DEV_PHRASE = 'bottom drive obey lake curtain smoke basket hold race lonely fit walk';
const derive = (name, scheme) => {
  const seed = mnemonicToMiniSecret(DEV_PHRASE);
  return keyFromPath(scheme === 'ed25519' ? ed25519PairFromSeed(seed) : sr25519PairFromSeed(seed), keyExtractPath(`//${name}`).path, scheme);
};
const ALICE_SR = HotkeySigner.fromKeypair(derive('Alice', 'sr25519'), 'sr25519');
const ALICE_ED = HotkeySigner.fromKeypair(derive('Alice', 'ed25519'), 'ed25519');
const BOB = encodeAddress(derive('Bob', 'sr25519').publicKey, 42);
const NONCE = '1752076800000000000';
const NONCE_MS = 1752076800000;
const BODY = '{"prompt": "hello"}';
const URL_ = new URL('https://miner.example/generate?stream=false');
const ED25519_SIGNATURE = '0x1a6b631988bf1f7ea093ab9d5acf61f05c316d0b0e428b24b487b75a5f6ee0e1a56a26918fdf871b6cf09437e6588023a4ce423cf622621b2a7feee17612f704';

test('the published fixtures derive to the published addresses', () => {
  assert.equal(ALICE_SR.ss58, '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY');
  assert.equal(ALICE_ED.ss58, '5FA9nQDVg267DEd8m1ZypXLBnvN7SFxYwV7ndqSYGiN9TTpu');
  assert.equal(BOB, '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty');
  assert.equal(Buffer.byteLength(BODY), 19);
  assert.equal(sha256Hex(new TextEncoder().encode(BODY)), '341c57448e531310fbbe83f44cea2a5e838bd9e8a6b82b269f01d0dbbc23c3cc');
});

test('the signed payload is the published eight lines, byte for byte', () => {
  const payload = btauthPayload({ scheme: 'sr25519', method: 'post', target: requestTarget(URL_), bodySha256: sha256Hex(new TextEncoder().encode(BODY)),
    nonce: NONCE, sender: ALICE_SR.ss58, receiver: BOB });
  assert.equal(payload, [
    'btauth/1', 'sr25519', 'POST', '/generate?stream=false', '341c57448e531310fbbe83f44cea2a5e838bd9e8a6b82b269f01d0dbbc23c3cc',
    '1752076800000000000', '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY', '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty',
  ].join('\n'));
  assert.ok(!payload.endsWith('\n'));
  assert.throws(() => btauthPayload({ scheme: 'sr25519', method: 'GET', target: '/a\nb', bodySha256: 'x', nonce: NONCE, sender: ALICE_SR.ss58, receiver: BOB }));
});

test('ed25519 reproduces the published signature exactly and sends X-Bittensor-Crypto', async () => {
  const headers = signRequest(ALICE_ED, { method: 'POST', url: URL_, body: BODY, receiver: BOB, nonce: NONCE });
  assert.deepEqual(headers, {
    'X-Bittensor-Version': '1', 'X-Bittensor-Hotkey': '5FA9nQDVg267DEd8m1ZypXLBnvN7SFxYwV7ndqSYGiN9TTpu', 'X-Bittensor-Receiver': BOB,
    'X-Bittensor-Nonce': NONCE, 'X-Bittensor-Signature': ED25519_SIGNATURE, 'X-Bittensor-Crypto': 'ed25519',
  });
  const verify = createVerifier({ receiver: BOB, senders: { [ALICE_ED.ss58]: 'ed25519' }, now: () => NONCE_MS });
  assert.equal((await verify({ method: 'POST', url: URL_.href, headers }, BODY)).crypto, 'ed25519');
  // A server that pins the sender to sr25519 refuses the ed25519 header before checking the signature.
  await assert.rejects(createVerifier({ receiver: BOB, senders: { [ALICE_ED.ss58]: 'sr25519' }, now: () => NONCE_MS })({ method: 'POST', url: URL_.href, headers }, BODY),
    error => error instanceof BtauthRejected && error.code === 'bad_signature');
});

test('sr25519 signs with the substrate context, omits X-Bittensor-Crypto and verifies like the API', async () => {
  const headers = signRequest(ALICE_SR, { method: 'POST', url: URL_, body: BODY, receiver: BOB, nonce: NONCE });
  assert.deepEqual(Object.keys(headers), ['X-Bittensor-Version', 'X-Bittensor-Hotkey', 'X-Bittensor-Receiver', 'X-Bittensor-Nonce', 'X-Bittensor-Signature']);
  assert.match(headers['X-Bittensor-Signature'], /^0x[0-9a-f]{128}$/);
  const verify = createVerifier({ receiver: BOB, now: () => NONCE_MS });
  assert.deepEqual(await verify({ method: 'POST', url: URL_.href, headers }, BODY),
    { hotkey: ALICE_SR.ss58, hotkeyId: Buffer.from(ALICE_SR.publicKey).toString('hex'), crypto: 'sr25519', nonce: NONCE });
  // sr25519 signatures are randomized: a second signature differs and verifies too.
  const again = signRequest(ALICE_SR, { method: 'POST', url: URL_, body: BODY, receiver: BOB, nonce: '1752076800000000001' });
  assert.notEqual(again['X-Bittensor-Signature'], headers['X-Bittensor-Signature']);
  assert.ok(await verify({ method: 'POST', url: URL_.href, headers: again }, BODY));
});

test('the signature binds the method, target, body, receiver and scheme', async () => {
  const headers = signRequest(ALICE_SR, { method: 'POST', url: URL_, body: BODY, receiver: BOB, nonce: NONCE });
  const reject = async (request, body, code, receiver = BOB) => assert.rejects(
    createVerifier({ receiver, now: () => NONCE_MS })(request, body), error => error.code === code, code);
  await reject({ method: 'PUT', url: URL_.href, headers }, BODY, 'bad_signature');
  await reject({ method: 'POST', url: 'https://miner.example/generate?stream=true', headers }, BODY, 'bad_signature');
  await reject({ method: 'POST', url: 'https://miner.example/other?stream=false', headers }, BODY, 'bad_signature');
  await reject({ method: 'POST', url: URL_.href, headers }, '{"prompt":"hello"}', 'bad_signature');
  await reject({ method: 'POST', url: URL_.href, headers }, BODY, 'wrong_receiver', ALICE_SR.ss58);
  await reject({ method: 'POST', url: URL_.href, headers: { ...headers, 'X-Bittensor-Crypto': 'sr25519' } }, BODY, 'bad_signature');
  await reject({ method: 'POST', url: URL_.href, headers: { ...headers, 'X-Bittensor-Signature': headers['X-Bittensor-Signature'].toUpperCase().replace('0X', '0x') } }, BODY, 'malformed_auth');
  await reject({ method: 'POST', url: URL_.href, headers: { ...headers, 'X-Bittensor-Version': '2' } }, BODY, 'malformed_auth');
  assert.throws(() => signRequest(ALICE_SR, { method: 'POST', url: URL_, body: BODY, receiver: '0x' + '11'.repeat(32) }));
  assert.throws(() => signRequest(ALICE_SR, { method: 'POST', url: new URL('https://miner.example/a#frag'), receiver: BOB }));
  assert.throws(() => signRequest(ALICE_SR, { method: 'POST', url: URL_, receiver: BOB, nonce: '0123' }));
});

test('freshness is -10 s to +2 s and a nonce is accepted once', async () => {
  const headers = signRequest(ALICE_SR, { method: 'POST', url: URL_, body: BODY, receiver: BOB, nonce: NONCE });
  for (const offset of [10_001, -2_001]) {
    await assert.rejects(createVerifier({ receiver: BOB, now: () => NONCE_MS + offset })({ method: 'POST', url: URL_.href, headers }, BODY),
      error => error.code === 'stale_request');
  }
  const verify = createVerifier({ receiver: BOB, now: () => NONCE_MS + 9_000 });
  await verify({ method: 'POST', url: URL_.href, headers }, BODY);
  await assert.rejects(verify({ method: 'POST', url: URL_.href, headers }, BODY), error => error.code === 'replayed_request');
});

test('every attempt takes a fresh, strictly increasing nanosecond nonce', async () => {
  const before = BigInt(Date.now()) * 1_000_000n;
  const nonces = Array.from({ length: 2000 }, () => freshNonce());
  const after = BigInt(Date.now() + 1) * 1_000_000n;
  assert.equal(new Set(nonces).size, nonces.length);
  for (let i = 0; i < nonces.length; i++) {
    assert.match(nonces[i], /^[1-9][0-9]{18}$/);
    if (i) assert.ok(BigInt(nonces[i]) > BigInt(nonces[i - 1]));
  }
  assert.ok(BigInt(nonces[0]) >= before && BigInt(nonces.at(-1)) < after + 2_000_000n);
  const a = signRequest(ALICE_SR, { method: 'GET', url: URL_, receiver: BOB }), b = signRequest(ALICE_SR, { method: 'GET', url: URL_, receiver: BOB });
  assert.notEqual(a['X-Bittensor-Nonce'], b['X-Bittensor-Nonce']);
  const verify = createVerifier({ receiver: BOB });
  await verify({ method: 'GET', url: URL_.href, headers: a });
  await verify({ method: 'GET', url: URL_.href, headers: b });
});

test('the signed target is the percent-encoded wire target that a server receives', async () => {
  const verify = createVerifier({ receiver: BOB });
  const received = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', async () => {
      const url = `http://127.0.0.1:${server.address().port}${request.url}`;
      try {
        const caller = await verify({ method: request.method, url, headers: request.headers }, new Uint8Array(Buffer.concat(chunks)));
        received.push(request.url);
        response.end(JSON.stringify(caller));
      } catch (error) { response.statusCode = 401; response.end(error.code); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const [path, body, method] of [['/a b/café?q=x y&r=%2F', undefined, 'GET'], ['/bare?', undefined, 'GET'], ['/api/v1/files', BODY, 'POST'],
      ['/bytes', new Uint8Array([0, 1, 2, 255]), 'PUT'], ['/empty-body', '', 'DELETE']]) {
      const url = new URL(path, base);
      const headers = signRequest(ALICE_SR, { method, url, body, receiver: BOB });
      const response = await fetch(url, { method, headers, ...(body === undefined ? {} : { body }) });
      assert.equal(response.status, 200, `${method} ${path}: ${await response.clone().text()}`);
      assert.equal((await response.json()).hotkey, ALICE_SR.ss58);
      assert.equal(received.at(-1), requestTarget(url));
    }
    // A bare "?" is dropped before signing, because fetch implementations disagree on sending it.
    assert.deepEqual(received.slice(0, 2), ['/a%20b/caf%C3%A9?q=x%20y&r=%2F', '/bare']);
    assert.throws(() => requestTarget(new URL('https://miner.example/bare?')), /bare_query/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('a signer never exposes its secret key', () => {
  const secret = Buffer.from(derive('Alice', 'sr25519').secretKey).toString('hex');
  for (const view of [JSON.stringify(ALICE_SR), inspect(ALICE_SR, { showHidden: true, depth: 5 }), JSON.stringify(Object.entries(ALICE_SR)), String(Object.keys(ALICE_SR))]) {
    assert.ok(!view.includes(secret.slice(0, 32)), view);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(ALICE_SR)), { hotkey: ALICE_SR.ss58, crypto: 'sr25519' });
});
