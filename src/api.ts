import type { Config } from './config.js';
import type { ApiRequest } from './tools.js';

const JSON_LIMIT = 4 * 1024 * 1024;
const DOWNLOAD_LIMIT = 256 * 1024;
let activeRequests = 0;
export class ApiError extends Error {
  constructor(public readonly code: string, public readonly status?: number, public readonly retryKey?: string) {
    super(`Reliquary request failed: ${code}.`);
  }
}

async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new ApiError('response_too_large');
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new ApiError('response_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

export class ApiClient {
  constructor(private readonly config: Config, private readonly fetcher: typeof fetch = fetch) {}
  async request(input: ApiRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const method = input.method ?? 'GET';
    const mutating = method !== 'GET';
    const retryKey = input.headers?.['Idempotency-Key'];
    if (mutating && !this.config.enableWrites) throw new ApiError('writes_disabled');
    const url = new URL(input.path, this.config.apiUrl);
    if (!input.path.startsWith('/api/') || input.path.startsWith('//') || url.origin !== this.config.apiUrl ||
        url.hash || /\/api\/(internal|admin|auth|custody|payments)(\/|$)/.test(url.pathname)) {
      throw new ApiError('invalid_route');
    }
    const headers = new Headers(input.headers);
    headers.set('Accept', input.download ? '*/*' : 'application/json');
    if (input.scope) {
      const key = this.config.keys[input.scope];
      if (!key) throw new ApiError('credential_required');
      headers.set('Authorization', `Bearer ${key}`);
    } else { headers.delete('Authorization'); }
    let body: string | undefined = input.body;
    if (input.json !== undefined) { body = JSON.stringify(input.json); headers.set('Content-Type', 'application/json'); }
    if (body !== undefined && Buffer.byteLength(body) > 5 * 1024 * 1024) throw new ApiError('request_too_large');
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    // ponytail: process-wide cap; add per-account scheduling only for shared hosting.
    if (activeRequests >= 32) throw new ApiError('server_busy');
    activeRequests++;
    try {
      const response = await this.fetcher(url, {
        method, headers, ...(body === undefined ? {} : { body }), redirect: 'manual', signal: requestSignal,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new ApiError(mutating ? 'outcome_unknown' : 'redirect_refused', response.status, retryKey);
      }
      let bytes: Buffer;
      try { bytes = await boundedBody(response, input.download && response.ok ? DOWNLOAD_LIMIT : JSON_LIMIT); }
      catch (error) {
        if (mutating) throw new ApiError('outcome_unknown', response.status, retryKey);
        throw error;
      }
      if (!response.ok) {
        if (mutating && response.status >= 500) throw new ApiError('outcome_unknown', response.status, retryKey);
        let code = `http_${response.status}`;
        try {
          const error = JSON.parse(bytes.toString('utf8'))?.error?.code;
          if (typeof error === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(error)) code = error;
        } catch { /* Error bodies may be plain text. */ }
        throw new ApiError(code, response.status, retryKey);
      }
      if (input.download) {
        return {
          encoding: 'base64', data: bytes.toString('base64'), bytes: bytes.length,
          mimeType: response.headers.get('content-type') ?? 'application/octet-stream',
          contentRange: response.headers.get('content-range'), etag: response.headers.get('etag'),
        };
      }
      try {
        const parsed: unknown = JSON.parse(bytes.toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not_object');
        return parsed as Record<string, unknown>;
      } catch { throw new ApiError(mutating ? 'outcome_unknown' : 'invalid_response', response.status, retryKey); }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(mutating ? 'outcome_unknown' : requestSignal.aborted ? 'request_aborted' : 'upstream_unavailable', undefined, retryKey);
    } finally { activeRequests--; }
  }
}
