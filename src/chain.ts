import { compactFromU8a, u8aConcat, u8aToHex } from '@polkadot/util';
import { blake2AsU8a, encodeAddress, xxhashAsU8a } from '@polkadot/util-crypto';
import { publicKeyOf, SS58_PREFIX } from './btauth.js';

// Read-only access to the Subtensor service registry. A service is SubtensorModule.Services[(netuid, hotkey)],
// a URL of a JSON document. There is no runtime API for it: the keys are paged over the storage prefix at the
// finalized head. Nothing here signs or submits a transaction.

export const FINNEY_RPC = 'https://entrypoint-finney.opentensor.ai';
const RPC_LIMIT = 8 * 1024 * 1024;
const PAGE = 256;
const MAX_SERVICES = 4096;
const HASH = /^0x[0-9a-f]{64}$/;
const HEX = /^0x(?:[0-9a-f]{2})*$/;

export class ChainError extends Error {
  constructor(public readonly code: string) { super(`Subtensor read failed: ${code}.`); }
}

/** The Subtensor JSON-RPC endpoint: RELIQUARY_BITTENSOR_RPC_URL or public Finney. Local HTTP needs explicit opt-in. */
export function bittensorRpcUrl(env: NodeJS.ProcessEnv): string {
  let url: URL;
  try { url = new URL(env.RELIQUARY_BITTENSOR_RPC_URL ?? FINNEY_RPC); } catch { throw new Error('Invalid Subtensor RPC URL.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash ||
      (url.protocol !== 'https:' && !(local && url.protocol === 'http:' && env.RELIQUARY_ALLOW_LOCAL_HTTP === 'true'))) {
    throw new Error('The Subtensor RPC URL must use HTTPS; local HTTP requires explicit opt-in.');
  }
  return url.href;
}

/** twox128("SubtensorModule") ++ twox128("Services"). */
export const SERVICES_PREFIX: Uint8Array = u8aConcat(xxhashAsU8a('SubtensorModule', 128), xxhashAsU8a('Services', 128));

function netuidBytes(netuid: number): Uint8Array {
  if (!Number.isInteger(netuid) || netuid < 0 || netuid > 0xffff) throw new ChainError('invalid_netuid');
  return new Uint8Array([netuid & 0xff, netuid >> 8]);
}

/** The storage prefix of every service, or of one subnet's services (netuid is stored as u16 LE, unhashed). */
export function servicesPrefix(netuid?: number): string {
  return u8aToHex(netuid === undefined ? SERVICES_PREFIX : u8aConcat(SERVICES_PREFIX, netuidBytes(netuid)));
}

/** prefix ++ netuid (u16 LE) ++ blake2_128(hotkey) ++ hotkey. */
export function serviceStorageKey(netuid: number, hotkey: string): string {
  const key = publicKeyOf(hotkey);
  if (!key) throw new ChainError('invalid_hotkey');
  return u8aToHex(u8aConcat(SERVICES_PREFIX, netuidBytes(netuid), blake2AsU8a(key, 128), key));
}

export interface ServiceKey { netuid: number; hotkey: string; publicKey: Uint8Array }

/** Decode a Services storage key, checking the prefix, the length and the blake2_128 hasher bytes. */
export function decodeServiceKey(hex: string): ServiceKey {
  if (typeof hex !== 'string' || !HEX.test(hex)) throw new ChainError('invalid_key');
  const bytes = Buffer.from(hex.slice(2), 'hex');
  if (bytes.length !== 32 + 2 + 16 + 32 || !bytes.subarray(0, 32).equals(SERVICES_PREFIX)) throw new ChainError('invalid_key');
  const netuid = bytes[32]! | (bytes[33]! << 8);
  const publicKey = new Uint8Array(bytes.subarray(50));
  if (!Buffer.from(blake2AsU8a(publicKey, 128)).equals(bytes.subarray(34, 50))) throw new ChainError('invalid_key');
  return { netuid, hotkey: encodeAddress(publicKey, SS58_PREFIX), publicKey };
}

/** Decode a Services value: a SCALE compact length followed by exactly that many bytes of UTF-8. */
export function decodeServiceUrl(hex: string): string {
  if (typeof hex !== 'string' || !HEX.test(hex) || hex.length < 4) throw new ChainError('invalid_value');
  const bytes = new Uint8Array(Buffer.from(hex.slice(2), 'hex'));
  let offset: number, length: number;
  try {
    const [size, value] = compactFromU8a(bytes);
    offset = size; length = value.toNumber();
  } catch { throw new ChainError('invalid_value'); }
  if (offset + length !== bytes.length) throw new ChainError('invalid_value');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset)); } catch { throw new ChainError('invalid_value'); }
}

export interface RegisteredService { netuid: number; hotkey: string; publicKey: Uint8Array; url: string }
export interface Registry { block: string; services: RegisteredService[]; invalid: number }

async function boundedText(response: Response, limit: number): Promise<string> {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new ChainError('response_too_large'); }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new ChainError('response_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size).toString('utf8');
}

/** A minimal JSON-RPC reader for the finalized Subtensor state. */
export class SubtensorReader {
  #id = 0;
  constructor(private readonly url: string, private readonly fetcher: typeof fetch = fetch, private readonly timeoutMs = 10_000) {}

  async call(method: string, params: unknown[], signal?: AbortSignal): Promise<unknown> {
    const id = ++this.#id;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let text: string;
    try {
      const response = await this.fetcher(this.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), redirect: 'manual', credentials: 'omit',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) { await response.body?.cancel(); throw new ChainError('rpc_unavailable'); }
      text = await boundedText(response, RPC_LIMIT);
    } catch (error) {
      if (error instanceof ChainError) throw error;
      throw new ChainError('rpc_unavailable');
    }
    let reply: { id?: unknown; result?: unknown; error?: unknown };
    try { reply = JSON.parse(text); } catch { throw new ChainError('rpc_invalid_response'); }
    if (!reply || typeof reply !== 'object' || reply.id !== id) throw new ChainError('rpc_invalid_response');
    if (reply.error !== undefined && reply.error !== null) throw new ChainError('rpc_error');
    return reply.result;
  }

  async finalizedHead(signal?: AbortSignal): Promise<string> {
    const head = await this.call('chain_getFinalizedHead', [], signal);
    if (typeof head !== 'string' || !HASH.test(head)) throw new ChainError('rpc_invalid_response');
    return head;
  }

  async storage(key: string, at: string, signal?: AbortSignal): Promise<string | null> {
    const value = await this.call('state_getStorage', [key, at], signal);
    if (value !== null && (typeof value !== 'string' || !HEX.test(value))) throw new ChainError('rpc_invalid_response');
    return value;
  }

  /** Every storage key under a prefix, paged, at one block. */
  async keys(prefix: string, at: string, signal?: AbortSignal): Promise<string[]> {
    const keys: string[] = [];
    for (let start = prefix; ;) {
      const page = await this.call('state_getKeysPaged', [prefix, PAGE, start, at], signal);
      if (!Array.isArray(page) || page.some(key => typeof key !== 'string' || !HEX.test(key) || !key.startsWith(prefix) || key <= start)) {
        throw new ChainError('rpc_invalid_response');
      }
      keys.push(...page as string[]);
      if (keys.length > MAX_SERVICES) throw new ChainError('too_many_services');
      if (page.length < PAGE) return keys;
      start = page.at(-1) as string;
    }
  }

  /** The values of known keys at one block, in batches. */
  async values(keys: string[], at: string, signal?: AbortSignal): Promise<Map<string, string | null>> {
    const values = new Map<string, string | null>();
    for (let index = 0; index < keys.length; index += 128) {
      const batch = keys.slice(index, index + 128);
      const sets = await this.call('state_queryStorageAt', [batch, at], signal);
      if (!Array.isArray(sets)) throw new ChainError('rpc_invalid_response');
      for (const set of sets) {
        if (!set || typeof set !== 'object' || !Array.isArray(set.changes)) throw new ChainError('rpc_invalid_response');
        for (const change of set.changes) {
          if (!Array.isArray(change) || typeof change[0] !== 'string' || !batch.includes(change[0]) ||
              (change[1] !== null && (typeof change[1] !== 'string' || !HEX.test(change[1])))) throw new ChainError('rpc_invalid_response');
          values.set(change[0], change[1]);
        }
      }
    }
    return values;
  }

  /** Every registered service (or one subnet's) at the finalized head. Undecodable entries are counted, not returned. */
  async services(netuid?: number, signal?: AbortSignal): Promise<Registry> {
    const block = await this.finalizedHead(signal);
    const keys = await this.keys(servicesPrefix(netuid), block, signal);
    const values = await this.values(keys, block, signal);
    const services: RegisteredService[] = [];
    let invalid = 0;
    for (const key of keys) {
      const value = values.get(key);
      if (value === undefined || value === null) continue;
      try { services.push({ ...decodeServiceKey(key), url: decodeServiceUrl(value) }); } catch { invalid++; }
    }
    return { block, services, invalid };
  }

  /** The service URL published for one (netuid, hotkey) at the finalized head, or null. */
  async service(netuid: number, hotkey: string, signal?: AbortSignal): Promise<{ block: string; url: string | null }> {
    const block = await this.finalizedHead(signal);
    const value = await this.storage(serviceStorageKey(netuid, hotkey), block, signal);
    return { block, url: value === null ? null : decodeServiceUrl(value) };
  }
}
