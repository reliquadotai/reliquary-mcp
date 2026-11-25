import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { mnemonicToMiniSecret, mnemonicValidate } from '@polkadot/util-crypto';
import { HotkeySigner, publicKeyOf, signRequest, ss58 } from './btauth.js';
import type { Config } from './config.js';

// Wallet mode: an agent that holds only a Bittensor hotkey signs each scoped Reliquary request with btauth/1
// instead of sending a workspace key. The hotkey file is read once at startup and never printed. No coldkey,
// seed or phrase is accepted from the environment or from a tool.

export const RELIQUARY_NETUID = 81;
export const DEFAULT_GAMMA_RECEIVER = '5H47sFL6bGi3xPLzKpHxFqjBnmRZkQh4gk5jzkCeNXn4wdDa';
const KEYFILE_LIMIT = 64 * 1024;

/** A configuration error whose fixed message is safe to print: it never holds file contents or key material. */
export class WalletConfigError extends Error {}

/** Wallet and hotkey names for the btcli spend command, read from the standard <wallets>/<wallet>/hotkeys/<hotkey> layout. */
export interface BtcliNames { wallet?: string; hotkey?: string; walletPath?: string }

export interface Wallet {
  signer: HotkeySigner;
  /** The Reliquary service hotkey: the btauth/1 receiver of every signed Reliquary request. */
  receiver: string;
  btcli: BtcliNames;
}

/** The Reliquary service hotkey, from RELIQUARY_GAMMA_RECEIVER or the default. */
export function gammaReceiver(env: NodeJS.ProcessEnv): string {
  const receiver = ss58(env.RELIQUARY_GAMMA_RECEIVER ?? DEFAULT_GAMMA_RECEIVER);
  if (!receiver) throw new WalletConfigError('RELIQUARY_GAMMA_RECEIVER must be an SS58 hotkey address.');
  return receiver;
}

function btcliNames(path: string): BtcliNames {
  const hotkeys = dirname(path);
  if (basename(hotkeys) !== 'hotkeys') return {};
  const walletDir = dirname(hotkeys), walletPath = dirname(walletDir);
  return { wallet: basename(walletDir), hotkey: basename(path),
    ...(walletPath === resolve(homedir(), '.bittensor', 'wallets') ? {} : { walletPath }) };
}

function declaredKey(data: Record<string, unknown>): Uint8Array {
  const keys: Uint8Array[] = [];
  for (const field of ['publicKey', 'accountId']) {
    const value = data[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new WalletConfigError(`The hotkey file has a malformed ${field}.`);
    keys.push(Buffer.from(value.slice(2), 'hex'));
  }
  if (data.ss58Address !== undefined && data.ss58Address !== null) {
    const key = typeof data.ss58Address === 'string' ? publicKeyOf(data.ss58Address) : undefined;
    if (!key) throw new WalletConfigError('The hotkey file has a malformed ss58Address.');
    keys.push(key);
  }
  const [first] = keys;
  if (!first) throw new WalletConfigError('The hotkey file declares no public key (publicKey, accountId or ss58Address) to check the secret against.');
  if (keys.some(key => !Buffer.from(key).equals(Buffer.from(first)))) throw new WalletConfigError('The hotkey file declares conflicting public keys.');
  return first;
}

function keyfileSigner(data: Record<string, unknown>): HotkeySigner {
  const expected = declaredKey(data);
  let seed: Uint8Array;
  if (data.secretSeed !== undefined && data.secretSeed !== null) {
    if (typeof data.secretSeed !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(data.secretSeed)) throw new WalletConfigError('The hotkey file has a malformed secretSeed.');
    seed = Buffer.from(data.secretSeed.slice(2), 'hex');
  } else if (typeof data.secretPhrase === 'string') {
    const phrase = data.secretPhrase.trim().split(/\s+/).join(' ');
    if (!mnemonicValidate(phrase)) throw new WalletConfigError('The hotkey file has an invalid secretPhrase.');
    seed = mnemonicToMiniSecret(phrase);
  } else throw new WalletConfigError('The hotkey file has neither secretSeed nor secretPhrase.');
  try {
    // A bare address does not say its scheme: the declared public key decides between sr25519 and ed25519.
    for (const scheme of ['sr25519', 'ed25519'] as const) {
      const signer = HotkeySigner.fromSeed(seed, scheme);
      if (Buffer.from(signer.publicKey).equals(Buffer.from(expected))) return signer;
    }
  } finally { seed.fill(0); }
  throw new WalletConfigError('The hotkey file does not hold an ordinary sr25519 or ed25519 hotkey matching its public key.');
}

/**
 * Wallet mode from RELIQUARY_HOTKEY_FILE (a bittensor wallet hotkey JSON) and RELIQUARY_GAMMA_RECEIVER.
 * Refused over HTTP, for a coldkey file, for an encrypted file and for any secret passed in the environment.
 */
export function loadWallet(env: NodeJS.ProcessEnv, transport: Config['transport']): Wallet | undefined {
  const secrets = Object.keys(env).filter(name => /^RELIQUARY_\w*(COLDKEY|SEED|MNEMONIC|PHRASE|PRIVATE_?KEY)/i.test(name) && env[name]);
  if (secrets.length) throw new WalletConfigError('Secrets are not accepted in environment variables: point RELIQUARY_HOTKEY_FILE at a hotkey file instead.');
  const file = env.RELIQUARY_HOTKEY_FILE;
  if (!file) {
    if (env.RELIQUARY_GAMMA_RECEIVER !== undefined) gammaReceiver(env);
    return undefined;
  }
  if (transport !== 'stdio') throw new WalletConfigError('Wallet mode runs over stdio only: unset RELIQUARY_HOTKEY_FILE for HTTP.');
  const receiver = gammaReceiver(env);
  const path = resolve(file === '~' || file.startsWith('~/') ? homedir() + file.slice(1) : file);
  if (/^coldkey/i.test(basename(path))) throw new WalletConfigError('RELIQUARY_HOTKEY_FILE names a coldkey file. Wallet mode takes a hotkey file only.');
  let text: string;
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > KEYFILE_LIMIT) throw new Error();
    text = readFileSync(path, 'utf8');
  } catch { throw new WalletConfigError('RELIQUARY_HOTKEY_FILE is not a readable hotkey file.'); }
  if (/^\s*\$/.test(text)) throw new WalletConfigError('The hotkey file is encrypted. Wallet mode needs an unencrypted bittensor hotkey file.');
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = undefined; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new WalletConfigError('The hotkey file is not a bittensor keyfile (JSON object).');
  return { signer: keyfileSigner(data as Record<string, unknown>), receiver, btcli: btcliNames(path) };
}

/** Replace any bearer credential with btauth/1 headers addressed to the Reliquary service hotkey. */
export function signWalletRequest(headers: Headers, wallet: Wallet, method: string, url: URL, body?: string | Uint8Array | null): void {
  headers.delete('Authorization');
  const stale: string[] = [];
  headers.forEach((_, name) => { if (name.toLowerCase().startsWith('x-bittensor-')) stale.push(name); });
  for (const name of stale) headers.delete(name);
  for (const [name, value] of Object.entries(signRequest(wallet.signer, { method, url, body, receiver: wallet.receiver }))) headers.set(name, value);
}

/**
 * A fetch for the packaged generation transport (batch upload and download). The transport marks credentialed
 * routes with a placeholder bearer key; this fetch removes it and signs those requests instead.
 */
export const WALLET_TRANSPORT_KEY = 'btauth-signed';
export function walletFetch(wallet: Wallet, fetcher: typeof fetch = fetch): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    if (input instanceof Request) throw new TypeError('Unsupported request.');
    const url = new URL(input);
    const headers = new Headers(init.headers);
    const credentialed = headers.has('Authorization');
    headers.delete('Authorization');
    if (credentialed) {
      const { body } = init;
      if (body !== undefined && body !== null && typeof body !== 'string' && !(body instanceof Uint8Array)) throw new TypeError('Unsupported request body.');
      signWalletRequest(headers, wallet, init.method ?? 'GET', url, body);
    }
    return fetcher(url, { ...init, headers });
  }) as typeof fetch;
}

/** Credentials for the packaged generation transport: the orders key, or wallet signing. */
export function orderTransportAuth(config: Config): { apiKey: string; fetch?: typeof fetch } {
  return config.wallet ? { apiKey: WALLET_TRANSPORT_KEY, fetch: walletFetch(config.wallet) } : { apiKey: config.keys.orders! };
}
