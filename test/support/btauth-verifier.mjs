// A btauth/1 verifier for tests, written from the public specification
// (https://www.bittensor.com/docs/guides/signed-requests) with the checks a Reliquary API service applies:
//   1. shape: version 1, every header present, a decimal nanosecond nonce, 0x + 128 lowercase hex signature,
//      SS58 sender and receiver (never hex keys), a raw body within the signed-body limit;
//   2. receiver: exactly the service's own hotkey string;
//   3. scheme: pinned per sender by the server (ordinary sr25519 for anonymous hotkeys); X-Bittensor-Crypto must
//      be absent for sr25519 and "ed25519" for ed25519;
//   4. freshness: at most 10 s old and at most 2 s ahead;
//   5. signature over the payload rebuilt from the received method, wire target and raw body bytes;
//   6. replay: each (hotkey, nonce) is accepted once, recorded only after the signature verifies.
import { createHash } from 'node:crypto';
import { decodeAddress, ed25519Verify, encodeAddress, sr25519Verify } from '@polkadot/util-crypto';

export class BtauthRejected extends Error {
  constructor(code) { super(code); this.code = code; }
}

function account(value) {
  if (typeof value !== 'string' || value.length > 100 || value.startsWith('0x')) throw new BtauthRejected('malformed_auth');
  let key;
  try { key = decodeAddress(value); } catch { throw new BtauthRejected('malformed_auth'); }
  if (key.length !== 32) throw new BtauthRejected('malformed_auth');
  return key;
}

/** The target as it arrived on the wire: path and query, keeping a bare trailing "?". */
export function wireTarget(href) {
  const url = new URL(href);
  return url.pathname + url.search + (!url.search && href.split('#')[0].endsWith('?') ? '?' : '');
}

/**
 * verify({ method, url, headers }, rawBody) resolves to { hotkey, hotkeyId, crypto, nonce } or rejects with
 * BtauthRejected(code). `senders` is 'ordinary-sr25519' or a map from sender SS58 to its trusted scheme.
 */
export function createVerifier({ receiver, senders = 'ordinary-sr25519', maxBodyBytes = 64 * 1024, now = () => Date.now() }) {
  const seen = new Set();
  return async function verify(request, rawBody = new Uint8Array()) {
    const headers = new Headers(request.headers);
    const get = name => headers.get(name);
    const sender = get('X-Bittensor-Hotkey'), target = get('X-Bittensor-Receiver'), nonce = get('X-Bittensor-Nonce');
    const signature = get('X-Bittensor-Signature'), claimed = get('X-Bittensor-Crypto');
    const body = rawBody instanceof Uint8Array ? rawBody : new TextEncoder().encode(rawBody);
    if (get('X-Bittensor-Version') !== '1' || !sender || !target || !nonce || !/^[1-9][0-9]{0,19}$/.test(nonce) ||
        !signature || !/^0x[0-9a-f]{128}$/.test(signature) || body.byteLength > maxBodyBytes) throw new BtauthRejected('malformed_auth');
    const publicKey = account(sender);
    account(target);
    if (target !== receiver) throw new BtauthRejected('wrong_receiver');
    let scheme = 'sr25519';
    if (senders !== 'ordinary-sr25519') {
      if (!Object.hasOwn(senders, sender)) throw new BtauthRejected('untrusted_sender');
      scheme = senders[sender];
    }
    if (scheme === 'sr25519' ? claimed !== null : claimed !== 'ed25519') throw new BtauthRejected('bad_signature');
    const nowNs = BigInt(now()) * 1_000_000n, sent = BigInt(nonce);
    if (sent < nowNs - 10_000_000_000n || sent > nowNs + 2_000_000_000n) throw new BtauthRejected('stale_request');
    const payload = ['btauth/1', scheme, request.method.toUpperCase(), wireTarget(request.url),
      createHash('sha256').update(body).digest('hex'), nonce, sender, target].join('\n');
    const bytes = new TextEncoder().encode(payload), sig = Buffer.from(signature.slice(2), 'hex');
    let valid = false;
    try { valid = scheme === 'sr25519' ? sr25519Verify(bytes, sig, publicKey) : ed25519Verify(bytes, sig, publicKey); } catch { valid = false; }
    if (!valid) throw new BtauthRejected('bad_signature');
    const hotkeyId = Buffer.from(publicKey).toString('hex');
    if (seen.has(`${hotkeyId}:${nonce}`)) throw new BtauthRejected('replayed_request');
    seen.add(`${hotkeyId}:${nonce}`);
    return { hotkey: encodeAddress(publicKey, 42), hotkeyId, crypto: scheme, nonce };
  };
}

/** The raw bytes a fetch init sends. */
export function initBody(init = {}) {
  const { body } = init;
  if (body === undefined || body === null) return new Uint8Array();
  return typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body);
}
