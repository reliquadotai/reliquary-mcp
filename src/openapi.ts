import { parse as parseYaml } from 'yaml';

// Reads a published OpenAPI 3.x or Swagger 2.0 spec without handing it to the agent whole: a page of a compact
// operation index, one operation with the local $ref targets it reaches, or one $ref target. Every value comes from
// the spec's publisher and is untrusted data. Index strings are cleaned and capped, and every answer fits the
// caller's byte budget.

export const INDEX_PAGE = 100;
export const INDEX_PAGE_MAX = 500;
export const REF_DEPTH = 8;
export const REF_DEPTH_MAX = 16;
/** Live specs nest at most 16 levels; a deeper document is refused, so no later walk can exhaust the stack. */
const MAX_NESTING = 128;
const YAML_ALIASES = 100;
/** Room kept for the list of refs an answer leaves out. */
const UNRESOLVED_ROOM = 24 * 1024;
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
export const HTTP_METHODS = ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH', 'TRACE'] as const;
export type HttpMethod = typeof HTTP_METHODS[number];
export type SpecFormat = 'json' | 'yaml';
export type SpecMedia = SpecFormat | 'sniff';

export class SpecError extends Error {
  constructor(public readonly code: string) { super(`Spec request failed: ${code}.`); }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

/** A published string for display: control characters and whitespace runs become one space, at most max code points. */
export function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = [...value.slice(0, max * 4 + 256).replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim()].slice(0, max).join('').trim();
  return clean || undefined;
}
function clipList(value: unknown, count: number, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const found = new Set<string>();
  for (const item of value.slice(0, count * 4)) {
    const clean = clip(item, max);
    if (clean) found.add(clean);
    if (found.size === count) break;
  }
  return [...found];
}

/** How a spec response is read, by its content type. Undefined refuses it, such as an HTML page. */
export function specMediaType(contentType: string): SpecMedia | undefined {
  const media = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  if (!media || media === 'text/plain' || media === 'application/octet-stream') return 'sniff';
  if (/\bjson\b/.test(media)) return 'json';
  if (/\bya?ml\b/.test(media) || media === 'application/vnd.oai.openapi') return 'yaml';
  return undefined;
}

/**
 * Parse a fetched spec. JSON, or YAML read as plain data with the core schema (no merge keys or language tags,
 * at most 100 aliases) and re-encoded as JSON within limit bytes, which also refuses aliases that contain themselves.
 * The result is always a finite tree: an object with a paths object, nested at most 128 levels.
 */
export function parseSpec(source: string, media: SpecMedia, limit: number): { spec: Record<string, unknown>; format: SpecFormat } {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  let parsed: { value: unknown; format: SpecFormat } | undefined;
  if (media === 'json' || (media === 'sniff' && /^\s*\{/.test(text))) {
    try { parsed = { value: JSON.parse(text), format: 'json' }; } catch { if (media === 'json') throw new SpecError('not_openapi'); }
  }
  parsed ??= { value: fromYaml(text, limit), format: 'yaml' };
  const spec = record(parsed.value);
  if (!spec || !record(spec.paths) || deeperThan(spec, MAX_NESTING)) throw new SpecError('not_openapi');
  return { spec, format: parsed.format };
}

function fromYaml(text: string, limit: number): unknown {
  let value: unknown;
  try {
    value = parseYaml(text, { schema: 'core', merge: false, resolveKnownTags: false, uniqueKeys: false, maxAliasCount: YAML_ALIASES,
      logLevel: 'error', prettyErrors: false });
  } catch { throw new SpecError('not_openapi'); }
  let size = 0;
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value, (key, item: unknown) => {
      size += key.length + (typeof item === 'string' ? item.length : 4);
      if (size > limit) throw new SpecError('response_too_large');
      return item;
    });
  } catch (error) { throw error instanceof SpecError ? error : new SpecError('not_openapi'); }
  if (encoded === undefined) throw new SpecError('not_openapi');
  if (Buffer.byteLength(encoded) > limit) throw new SpecError('response_too_large');
  return JSON.parse(encoded);
}

function deeperThan(root: object, max: number): boolean {
  const stack: [object, number][] = [[root, 1]];
  for (let next = stack.pop(); next; next = stack.pop()) {
    const [node, depth] = next;
    if (depth > max) return true;
    for (const child of Object.values(node)) if (child !== null && typeof child === 'object') stack.push([child, depth + 1]);
  }
  return false;
}

/** The value a local ref ("#/a/b~1c") points at, own properties only; undefined when there is none. */
export function pointer(spec: unknown, ref: string): unknown {
  if (ref === '#') return spec;
  if (!ref.startsWith('#/')) return undefined;
  let node = spec;
  for (const segment of ref.slice(2).split('/')) {
    let key: string;
    try { key = decodeURIComponent(segment).replace(/~1/g, '/').replace(/~0/g, '~'); } catch { return undefined; }
    if (Array.isArray(node)) {
      if (!/^(0|[1-9]\d{0,8})$/.test(key) || Number(key) >= node.length) return undefined;
      node = node[Number(key)];
    } else {
      const object = record(node);
      if (!object || !Object.hasOwn(object, key)) return undefined;
      node = object[key];
    }
  }
  return node;
}

/** An object, following local refs (a few hops at most); undefined when it does not resolve to one. */
function deref(spec: Record<string, unknown>, value: unknown): Record<string, unknown> | undefined {
  let node = record(value);
  for (let hop = 0; hop < 8 && node && typeof node.$ref === 'string'; hop++) node = record(pointer(spec, node.$ref));
  return node && typeof node.$ref !== 'string' ? node : undefined;
}

export interface IndexEntry {
  method: HttpMethod; path: string; operationId?: string; summary?: string; tags?: string[];
  /** Alternatives, each the schemes it combines joined by "+"; "none" when no credential is needed. */
  security?: string[];
  requestTypes?: string[]; responseTypes?: string[]; deprecated?: true;
}
interface Located { entry: IndexEntry; pathKey: string; method: typeof METHODS[number] }
export interface SpecServer { url: string; callable: boolean; description?: string }
export interface SpecView { specUrl: string; callable: readonly string[]; budget: number }

function requirements(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.length) return ['none'];
  return [...new Set(value.slice(0, 8).map(item =>
    Object.keys(record(item) ?? {}).slice(0, 4).map(name => clip(name, 64)).filter(Boolean).join('+') || 'none'))];
}
const mediaTypes = (content: unknown): string[] => clipList(Object.keys(record(content) ?? {}), 8, 100);
const firstLine = (value: unknown): string | undefined =>
  typeof value === 'string' ? value.slice(0, 4000).split('\n').map(line => line.trim()).find(Boolean) : undefined;

function locate(spec: Record<string, unknown>): Located[] {
  const swagger = typeof spec.swagger === 'string';
  const located: Located[] = [];
  for (const [pathKey, value] of Object.entries(record(spec.paths) ?? {})) {
    const item = record(value), path = clip(pathKey, 512);
    if (!item || !path) continue;
    for (const method of METHODS) {
      const op = record(item[method]);
      if (!op) continue;
      const operationId = clip(op.operationId, 200), summary = clip(op.summary, 200) ?? clip(firstLine(op.description), 200);
      const tags = clipList(op.tags, 8, 64), security = requirements(op.security !== undefined ? op.security : spec.security);
      let requestTypes: string[], responseTypes: string[];
      if (swagger) {
        const parameters = [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(op.parameters) ? op.parameters : [])];
        const sends = parameters.slice(0, 64).some(p => ['body', 'formData'].includes(String(deref(spec, p)?.in)));
        requestTypes = sends ? clipList(op.consumes ?? spec.consumes, 8, 100) : [];
        responseTypes = clipList(op.produces ?? spec.produces, 8, 100);
      } else {
        requestTypes = mediaTypes(deref(spec, op.requestBody)?.content);
        const types = new Set<string>();
        for (const response of Object.values(record(op.responses) ?? {}).slice(0, 32)) for (const type of mediaTypes(deref(spec, response)?.content)) types.add(type);
        responseTypes = [...types].slice(0, 8);
      }
      located.push({ pathKey, method, entry: {
        method: method.toUpperCase() as HttpMethod, path, ...(operationId ? { operationId } : {}), ...(summary ? { summary } : {}),
        ...(tags.length ? { tags } : {}), ...(security ? { security } : {}), ...(requestTypes.length ? { requestTypes } : {}),
        ...(responseTypes.length ? { responseTypes } : {}), ...(op.deprecated === true ? { deprecated: true as const } : {}),
      } });
    }
  }
  return located;
}

/**
 * Where the API is served: OpenAPI servers (variables at their defaults) or Swagger host, basePath and schemes,
 * resolved against the spec URL. callable says whether bittensor_call may reach it: https on a declared origin.
 */
function serversOf(spec: Record<string, unknown>, view: SpecView, override?: unknown): SpecServer[] {
  const servers: SpecServer[] = [];
  const add = (raw: string, description?: unknown) => {
    if (raw.length > 2048) return;
    let url: URL | undefined;
    try { url = new URL(raw, view.specUrl); } catch { /* shown as published */ }
    const web = url && (url.protocol === 'https:' || url.protocol === 'http:') ? url : undefined;
    const shown = web?.href ?? clip(raw, 512), note = clip(description, 200);
    if (!shown) return;
    servers.push({ url: shown, callable: web?.protocol === 'https:' && !web.username && !web.password && view.callable.includes(web.origin),
      ...(note ? { description: note } : {}) });
  };
  if (typeof spec.swagger === 'string') {
    const base = new URL(view.specUrl);
    const host = typeof spec.host === 'string' && spec.host ? spec.host : base.host;
    const basePath = typeof spec.basePath === 'string' && spec.basePath.startsWith('/') ? spec.basePath : '/';
    const schemes = clipList(spec.schemes, 4, 8);
    for (const scheme of schemes.length ? schemes : [base.protocol.slice(0, -1)]) add(`${scheme}://${host}${basePath}`);
    return servers;
  }
  const declared = [override, spec.servers].find(value => Array.isArray(value) && value.length) as unknown[] | undefined;
  for (const item of declared?.slice(0, 8) ?? [{ url: '/' }]) {
    const server = record(item);
    if (typeof server?.url !== 'string') continue;
    const variables = record(server.variables);
    add(variables ? server.url.replace(/\{([^{}]{1,64})\}/g, (whole, name: string) => {
      const fallback = Object.hasOwn(variables, name) ? record(variables[name])?.default : undefined;
      return typeof fallback === 'string' ? fallback : whole;
    }) : server.url, server.description);
  }
  return servers;
}

/** Security schemes by name (only the named ones when a set is given), each reduced to its short fields. */
function securitySchemes(spec: Record<string, unknown>, only?: Set<string>): Record<string, Record<string, string>> | undefined {
  const all = record(record(spec.components)?.securitySchemes) ?? record(spec.securityDefinitions);
  const schemes: [string, Record<string, string>][] = [];
  for (const [rawName, value] of Object.entries(all ?? {})) {
    const name = clip(rawName, 64), scheme = deref(spec, value);
    if (!name || !scheme || (only && !only.has(name))) continue;
    const fields: [string, string][] = [];
    for (const [key, max] of [['type', 32], ['scheme', 32], ['bearerFormat', 64], ['in', 16], ['name', 128], ['description', 300], ['openIdConnectUrl', 512]] as const) {
      const value = clip(scheme[key], max);
      if (value) fields.push([key, value]);
    }
    schemes.push([name, Object.fromEntries(fields)]);
    if (schemes.length === 16) break;
  }
  return schemes.length ? Object.fromEntries(schemes) : undefined;
}

/** Every string $ref in a value, once each, in document order. */
function refsIn(root: unknown): string[] {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    const node = record(value);
    if (!node) return;
    if (typeof node.$ref === 'string') found.add(node.$ref);
    for (const [key, child] of Object.entries(node)) if (key !== '$ref' && child !== null && typeof child === 'object') walk(child);
  };
  walk(root);
  return [...found];
}

export interface Unresolved { ref: string; reason: 'depth' | 'size' | 'missing' | 'external' }

/**
 * The local ref targets a value reaches, each included once, breadth first, up to depth hops and room bytes. A
 * target that does not fit ends the bundle, so a hostile spec cannot make it expand or cost more than one pass.
 */
function bundle(spec: Record<string, unknown>, root: unknown, depth: number, room: number, rootRef?: string): Record<string, unknown> {
  const components: [string, unknown][] = [];
  const unresolved: Unresolved[] = [];
  const seen = new Set<string>(rootRef === undefined ? [] : [rootRef]);
  let used = 2, full = false;
  let frontier = refsIn(root);
  for (let hop = 1; frontier.length; hop++) {
    const next: string[] = [];
    for (const ref of frontier) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      const reason = !ref.startsWith('#') ? 'external' : hop > depth ? 'depth' : full ? 'size' : undefined;
      if (reason) { unresolved.push({ ref, reason }); continue; }
      const target = pointer(spec, ref);
      if (target === undefined) { unresolved.push({ ref, reason: 'missing' }); continue; }
      const size = bytesOf(ref) + bytesOf(target) + 2;
      if (used + size > room) { full = true; unresolved.push({ ref, reason: 'size' }); continue; }
      used += size;
      components.push([ref, target]);
      for (const found of refsIn(target)) next.push(found);
    }
    frontier = next;
  }
  const listed: Unresolved[] = [];
  let listedBytes = 0;
  for (const entry of unresolved) {
    const shown = { ref: entry.ref.slice(0, 2048), reason: entry.reason };
    listedBytes += bytesOf(shown) + 1;
    if (listedBytes > UNRESOLVED_ROOM - 256) break;
    listed.push(shown);
  }
  return { components: Object.fromEntries(components),
    ...(unresolved.length ? { unresolved: listed, unresolvedCount: unresolved.length } : {}), ...(full ? { truncated: true } : {}) };
}

/** Path-level parameters apply to the operation unless it declares one with the same name and location. */
function mergeParameters(spec: Record<string, unknown>, inherited: unknown, own: unknown): unknown[] | undefined {
  const mine = Array.isArray(own) ? own : [];
  if (!Array.isArray(inherited) || !inherited.length) return Array.isArray(own) ? own : undefined;
  const key = (parameter: unknown) => { const p = deref(spec, parameter); return p ? `${String(p.in)}\u0000${String(p.name)}` : undefined; };
  const overridden = new Set(mine.map(key));
  return [...inherited.filter(parameter => { const k = key(parameter); return k === undefined || !overridden.has(k); }), ...mine];
}

/** A parsed spec and the views of it the router returns. */
export class OpenApiSpec {
  #operations: Located[] | undefined;
  constructor(readonly spec: Record<string, unknown>, readonly format: SpecFormat, readonly url: string, readonly bytes: number) {}

  #located(): Located[] { return this.#operations ??= locate(this.spec); }

  info(view: SpecView): Record<string, unknown> {
    const meta = record(this.spec.info);
    const title = clip(meta?.title, 200), version = clip(meta?.version, 64), description = clip(meta?.description, 2000);
    const openapi = clip(this.spec.openapi, 16), swagger = clip(this.spec.swagger, 16);
    const notes = new Map<string, string>();
    for (const item of Array.isArray(this.spec.tags) ? this.spec.tags.slice(0, 512) : []) {
      const tag = record(item), name = clip(tag?.name, 64), note = clip(tag?.description, 100);
      if (name && note && !notes.has(name)) notes.set(name, note);
    }
    const counts = new Map<string, number>();
    for (const { entry } of this.#located()) for (const tag of entry.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    const tags = [...counts].slice(0, 100).map(([name, count]) => ({ name, count, ...(notes.has(name) ? { description: notes.get(name) } : {}) }));
    const schemes = securitySchemes(this.spec), security = requirements(this.spec.security);
    return { ...(title ? { title } : {}), ...(version ? { version } : {}), ...(openapi ? { openapi } : {}), ...(swagger ? { swagger } : {}),
      ...(description ? { description } : {}), servers: serversOf(this.spec, view),
      ...(schemes ? { securitySchemes: schemes } : {}), ...(security ? { security } : {}), ...(tags.length ? { tags } : {}) };
  }

  /** A page of the operation index: the spec's info on the first page, then entries until limit or the budget. */
  index(view: SpecView & { query?: string | undefined; offset?: number | undefined; limit?: number | undefined }): Record<string, unknown> {
    const terms = view.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    const all = this.#located().map(o => o.entry);
    const matched = terms.length ? all.filter(entry => {
      const haystack = [entry.method, entry.path, entry.operationId, entry.summary, ...(entry.tags ?? [])].filter(Boolean).join(' ').toLowerCase();
      return terms.every(term => haystack.includes(term));
    }) : all;
    const offset = view.offset ?? 0, limit = view.limit ?? INDEX_PAGE;
    const head = { ...(offset === 0 ? { info: this.info(view) } : {}), total: all.length, matched: matched.length, offset };
    let room = view.budget - bytesOf(head) - 512;
    const operations: IndexEntry[] = [];
    let next = offset;
    for (; next < matched.length && operations.length < limit; next++) {
      const size = bytesOf(matched[next]) + 1;
      if (size > room) break;
      room -= size;
      operations.push(matched[next]!);
    }
    if (!operations.length && next < matched.length) throw new SpecError('index_too_large');
    return { ...head, count: operations.length, ...(next < matched.length ? { nextOffset: next } : {}), operations,
      ...(operations.length ? { hint: 'Read one operation with operationId, or method and path; read a $ref it leaves unresolved with ref.' } : {}) };
  }

  /** One operation, as the index names it, with the components it reaches; undefined when there is none. */
  operation(view: SpecView & { operationId?: string | undefined; method?: HttpMethod | undefined; path?: string | undefined; depth: number }): Record<string, unknown> | undefined {
    const id = clip(view.operationId, 200), path = clip(view.path, 512);
    const found = this.#located().find(({ entry }) => id !== undefined ? entry.operationId === id : entry.method === view.method && entry.path === path);
    if (!found) return undefined;
    const item = record(record(this.spec.paths)?.[found.pathKey]) ?? {};
    const op = record(item[found.method]) ?? {};
    const { method: _method, path: _path, parameters: _parameters, security: _security, consumes: _consumes, produces: _produces, ...rest } = op;
    const parameters = mergeParameters(this.spec, item.parameters, op.parameters);
    const security = op.security !== undefined ? op.security : this.spec.security;
    const swagger = typeof this.spec.swagger === 'string';
    const consumes = op.consumes ?? (swagger ? this.spec.consumes : undefined), produces = op.produces ?? (swagger ? this.spec.produces : undefined);
    const operation = { method: found.entry.method, path: found.entry.path, ...rest, ...(parameters ? { parameters } : {}),
      ...(security !== undefined ? { security } : {}), ...(consumes !== undefined ? { consumes } : {}), ...(produces !== undefined ? { produces } : {}) };
    const names = new Set(Array.isArray(security) ? security.flatMap(item => Object.keys(record(item) ?? {}).map(name => clip(name, 64) ?? '')) : []);
    const schemes = names.size ? securitySchemes(this.spec, names) : undefined;
    const head = { servers: serversOf(this.spec, view, op.servers ?? item.servers), operation, ...(schemes ? { securitySchemes: schemes } : {}), depth: view.depth };
    const room = view.budget - bytesOf(head) - UNRESOLVED_ROOM;
    if (room < 0) throw new SpecError('operation_too_large');
    return { ...head, ...bundle(this.spec, operation, view.depth, room) };
  }

  /** One local ref target with the components it reaches; undefined when the ref points at nothing. */
  ref(view: SpecView & { ref: string; depth: number }): Record<string, unknown> | undefined {
    const value = pointer(this.spec, view.ref);
    if (value === undefined) return undefined;
    const head = { ref: view.ref, value, depth: view.depth };
    const room = view.budget - bytesOf(head) - UNRESOLVED_ROOM;
    if (room < 0) throw new SpecError('ref_too_large');
    return { ...head, ...bundle(this.spec, value, view.depth, room, view.ref) };
  }
}
