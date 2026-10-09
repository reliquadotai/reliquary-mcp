import type { Config } from './config.js';
import type { ApiRequest } from './tools.js';
import { parseGenerationResponse } from '@reliquary/api';
import { createJobsClient, JobApiError } from '@reliquary/api/jobs';

const JSON_LIMIT = 4 * 1024 * 1024;
const DOWNLOAD_LIMIT = 256 * 1024;
let activeRequests = 0;
export class ApiError extends Error {
  constructor(public readonly code: string, public readonly status?: number, public readonly retryKey?: string, public readonly revision?: string, public readonly requestId?: string, public readonly retryAfterSeconds?: number) {
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
    if (input.jobCall) {
      const client = createJobsClient(async (path, init = {}) => {
        const headers: Record<string, string> = {};
        new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
        try {
          return await this.request({ path, scope: 'resources', jobProtocol: true,
            ...(init.method ? { method: init.method as 'GET' | 'POST' } : {}), headers,
            ...(typeof init.body === 'string' ? { body: init.body } : {}),
          }, signal);
        } catch (error) {
          if (error instanceof ApiError) throw new JobApiError(error.code, error.code === 'server_busy' ? 429 : error.status, error.retryKey, error.revision, error.requestId, error.retryAfterSeconds);
          throw error;
        }
      });
      const call = input.jobCall;
      try {
        switch (call.operation) {
          case 'capabilities': return await client.capabilities(signal) as unknown as Record<string, unknown>;
          case 'list': return await client.list(call.page, signal) as unknown as Record<string, unknown>;
          case 'detail': return { schema_version: 1, job: await client.detail(call.id, signal) };
          case 'events': return await client.events(call.id, call.page, signal) as unknown as Record<string, unknown>;
          case 'artifact': return { schema_version: 1, ...await client.artifact(call.id, call.artifactId, signal) };
          case 'uploadInput': return { schema_version: 1, input: await client.uploadInput(call.input, call.key) };
          case 'create': return { schema_version: 1, job: await client.create(call.input, call.key) };
          case 'control': return { schema_version: 1, job: await client.control(call.id, call.action, call.input, call.key) };
        }
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (error instanceof JobApiError) throw new ApiError(error.code, error.status, error.requestKey, error.revision, error.requestId, error.retryAfterSeconds);
        throw new ApiError('invalid_response');
      }
    }
    const method = input.method ?? 'GET';
    const mutating = method !== 'GET';
    const initialHeaders = new Headers(input.headers);
    const retryKey = initialHeaders.get('Idempotency-Key') ?? undefined;
    const revision = initialHeaders.get('X-Resource-Revision') ?? undefined;
    if (mutating && !this.config.enableWrites) throw new ApiError('writes_disabled');
    const url = new URL(input.path, this.config.apiUrl);
    if (!input.path.startsWith('/api/') || input.path.startsWith('//') || url.origin !== this.config.apiUrl ||
        url.hash || /\/api\/(internal|admin|auth|custody|payments)(\/|$)/.test(url.pathname)) {
      throw new ApiError('invalid_route');
    }
    const headers = new Headers(input.headers);
    headers.delete('Cookie');
    headers.set('Accept', input.download ? '*/*' : 'application/json');
    if (input.scope) {
      const key = this.config.keys[input.scope];
      if (!key) throw new ApiError('credential_required');
      headers.set('Authorization', `Bearer ${key}`);
    } else { headers.delete('Authorization'); }
    let body: string | undefined = input.body;
    if (input.json !== undefined) { body = JSON.stringify(input.json); headers.set('Content-Type', 'application/json'); }
    if (input.jobProtocol && body !== undefined) headers.set('Content-Type', 'application/json');
    const requestLimit = input.jobProtocol ? (url.pathname === '/api/v1/job-inputs' ? 256 * 1024 : 32 * 1024) : 5 * 1024 * 1024;
    if (body !== undefined && Buffer.byteLength(body) > requestLimit) throw new ApiError('request_too_large');
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    // ponytail: process-wide cap; add per-account scheduling only for shared hosting.
    if (activeRequests >= 32) throw new ApiError('server_busy');
    activeRequests++;
    let requestId: string | undefined, retryAfterSeconds: number | undefined;
    try {
      const response = await this.fetcher(url, {
        method, headers, ...(body === undefined ? {} : { body }), redirect: 'manual', signal: requestSignal, credentials: 'omit',
      });
      const reference = response.headers.get('X-Request-ID'), retry = response.headers.get('Retry-After');
      if (reference && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(reference)) requestId = reference;
      if (retry && /^\d{1,5}$/.test(retry) && Number(retry) <= 86400) retryAfterSeconds = Number(retry);
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new ApiError(mutating ? 'outcome_unknown' : 'redirect_refused', response.status, retryKey, revision, requestId, retryAfterSeconds);
      }
      let bytes: Buffer;
      try { bytes = await boundedBody(response, input.download && response.ok ? DOWNLOAD_LIMIT : JSON_LIMIT); }
      catch (error) {
        if (mutating) throw new ApiError('outcome_unknown', response.status, retryKey, revision, requestId, retryAfterSeconds);
        if (error instanceof ApiError) throw new ApiError(error.code, response.status, retryKey, revision, requestId, retryAfterSeconds);
        throw error;
      }
      if (!response.ok) {
        if (mutating && (response.status >= 500 || response.status === 408)) throw new ApiError('outcome_unknown', response.status, retryKey, revision, requestId, retryAfterSeconds);
        let code = `http_${response.status}`;
        try {
          const error = JSON.parse(bytes.toString('utf8'))?.error?.code;
          if (typeof error === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(error)) code = error;
        } catch { /* Error bodies may be plain text. */ }
        throw new ApiError(code, response.status, retryKey, revision, requestId, retryAfterSeconds);
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
        return input.generationResponse
          ? parseGenerationResponse(input.generationResponse, parsed, 'key', input.generationExpected) as Record<string, unknown>
          : parsed as Record<string, unknown>;
      } catch { throw new ApiError(mutating ? 'outcome_unknown' : 'invalid_response', response.status, retryKey, revision, requestId, retryAfterSeconds); }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(mutating ? 'outcome_unknown' : requestSignal.aborted ? 'request_aborted' : 'upstream_unavailable', undefined, retryKey, revision, requestId, retryAfterSeconds);
    } finally { activeRequests--; }
  }
}
