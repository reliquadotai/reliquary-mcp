import { createHash, randomInt } from 'node:crypto';
import { inspect } from 'node:util';
import { decodeAddress, ed25519PairFromSeed, ed25519Sign, encodeAddress, sr25519PairFromSeed, sr25519Sign } from '@polkadot/util-crypto';

// btauth/1, the hotkey-signed HTTP request format of Bittensor:
// https://www.bittensor.com/docs/guides/signed-requests
export const BTAUTH = 'btauth/1';
export type BtauthScheme = 'sr25519' | 'ed25519';
/** The generic SS58 prefix that Bittensor addresses use. */
export const SS58_PREFIX = 42;
const NONCE = /^[1-9][0-9]{0,19}$/;

export class BtauthError extends Error {
  constructor(public readonly code: string) { super(`btauth/1 signing failed: ${code}.`); }
}

/** The 32-byte public key of an SS58 address, or undefined when it is not one. Hex public keys are refused. */
export function publicKeyOf(address: string): Uint8Array | undefined {
  if (typeof address !== 'string' || address.length > 100 || address.startsWith('0x')) return undefined;
  try {
    const bytes = decodeAddress(address);
    return bytes.length === 32 ? bytes : undefined;
  } catch { return undefined; }
}

/** An SS58 address in the generic Bittensor format, or undefined when the input is not an address. */
export function ss58(address: string): string | undefined {
  const key = publicKeyOf(address);
  return key && encodeAddress(key, SS58_PREFIX);
}

/** Lowercase hex sha256 of the exact body bytes. */
export function sha256Hex(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

/** The bytes a fetch body sends: a string as UTF-8, bytes as they are, and nothing as the empty body. */
export function bodyBytes(body: string | Uint8Array | null | undefined): Uint8Array {
  if (body === undefined || body === null) return new Uint8Array();
  return typeof body === 'string' ? new TextEncoder().encode(body) : body;
}

/**
 * Drop a bare trailing "?" in place. Fetch implementations disagree on sending it (some send /path?, others
 * /path), so a URL is normalised before it is both signed and sent.
 */
export function dropBareQuery(url: URL): URL {
  if (!url.search && url.href.endsWith('?')) url.search = '';
  return url;
}

/** The request target as sent: the percent-encoded path plus ?query of a URL without a fragment or bare "?". */
export function requestTarget(url: URL): string {
  if (url.hash) throw new BtauthError('fragment_not_sent');
  if (!url.search && url.href.endsWith('?')) throw new BtauthError('bare_query');
  return url.pathname + url.search;
}

export interface PayloadFields {
  scheme: BtauthScheme;
  method: string;
  target: string;
  bodySha256: string;
  nonce: string;
  sender: string;
  receiver: string;
}

/** The exact signed text: eight lines joined by \n, without a trailing newline. */
export function btauthPayload(fields: PayloadFields): string {
  const lines = [BTAUTH, fields.scheme, fields.method.toUpperCase(), fields.target, fields.bodySha256, fields.nonce, fields.sender, fields.receiver];
  if (lines.some(line => /[\r\n]/.test(line))) throw new BtauthError('invalid_payload');
  return lines.join('\n');
}

let lastNonce = 0n;
/**
 * A fresh nonce: unix time in nanoseconds as a decimal string. Sub-millisecond digits are random, and the
 * value strictly increases within this process, so two attempts never share a nonce.
 */
export function freshNonce(): string {
  const candidate = BigInt(Date.now()) * 1_000_000n + BigInt(randomInt(1_000_000));
  lastNonce = candidate > lastNonce ? candidate : lastNonce + 1n;
  return lastNonce.toString();
}

/**
 * An ordinary sr25519 or ed25519 hotkey held in memory. The secret key is a private field: it is never
 * serialised, inspected or returned.
 */
export class HotkeySigner {
  readonly #secretKey: Uint8Array;
  readonly ss58: string;

  private constructor(readonly scheme: BtauthScheme, readonly publicKey: Uint8Array, secretKey: Uint8Array) {
    if (publicKey.length !== 32 || secretKey.length !== 64) throw new BtauthError('invalid_key');
    this.#secretKey = secretKey;
    this.ss58 = encodeAddress(publicKey, SS58_PREFIX);
  }

  /** A hotkey from its 32-byte seed, as bittensor keyfiles store it in secretSeed. */
  static fromSeed(seed: Uint8Array, scheme: BtauthScheme): HotkeySigner {
    if (seed.length !== 32) throw new BtauthError('invalid_seed');
    const pair = scheme === 'sr25519' ? sr25519PairFromSeed(seed) : ed25519PairFromSeed(seed);
    return new HotkeySigner(scheme, pair.publicKey, pair.secretKey);
  }

  /**
   * A hotkey from a derived keypair, such as a development account. sr25519 secret keys have 64 bytes;
   * ed25519 secret keys are the 32-byte seed followed by the public key.
   */
  static fromKeypair(pair: { publicKey: Uint8Array; secretKey: Uint8Array }, scheme: BtauthScheme): HotkeySigner {
    return new HotkeySigner(scheme, pair.publicKey.slice(), pair.secretKey.slice());
  }

  sign(message: Uint8Array): Uint8Array {
    const pair = { publicKey: this.publicKey, secretKey: this.#secretKey };
    return this.scheme === 'sr25519' ? sr25519Sign(message, pair) : ed25519Sign(message, pair);
  }

  toJSON(): { hotkey: string; crypto: BtauthScheme } { return { hotkey: this.ss58, crypto: this.scheme }; }
  [inspect.custom](): string { return `HotkeySigner { hotkey: '${this.ss58}', crypto: '${this.scheme}' }`; }
}

export interface SignInput {
  method: string;
  url: URL;
  body?: string | Uint8Array | null | undefined;
  /** The service hotkey the request is addressed to. */
  receiver: string;
  /** Only for fixed test vectors: every real attempt takes a fresh nonce. */
  nonce?: string;
}

/**
 * The btauth/1 headers for one attempt (X-Bittensor-Crypto only for ed25519). The URL is normalised in place
 * (see dropBareQuery): send that same URL object.
 */
export function signRequest(signer: HotkeySigner, input: SignInput): Record<string, string> {
  dropBareQuery(input.url);
  const method = input.method.toUpperCase();
  if (!/^[A-Z]{1,16}$/.test(method)) throw new BtauthError('invalid_method');
  const receiver = ss58(input.receiver);
  if (!receiver) throw new BtauthError('invalid_receiver');
  const nonce = input.nonce ?? freshNonce();
  if (!NONCE.test(nonce)) throw new BtauthError('invalid_nonce');
  const payload = btauthPayload({
    scheme: signer.scheme, method, target: requestTarget(input.url), bodySha256: sha256Hex(bodyBytes(input.body)),
    nonce, sender: signer.ss58, receiver,
  });
  const signature = signer.sign(new TextEncoder().encode(payload));
  if (signature.length !== 64) throw new BtauthError('invalid_signature');
  return {
    'X-Bittensor-Version': '1',
    'X-Bittensor-Hotkey': signer.ss58,
    'X-Bittensor-Receiver': receiver,
    'X-Bittensor-Nonce': nonce,
    'X-Bittensor-Signature': '0x' + Buffer.from(signature).toString('hex'),
    ...(signer.scheme === 'ed25519' ? { 'X-Bittensor-Crypto': 'ed25519' } : {}),
  };
}
