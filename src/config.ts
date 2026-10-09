export const scopes = ['resources', 'orders', 'evaluations', 'training'] as const;
// A 5 MiB JSONL string can double when escaped inside a protocol message.
export const mcpMessageLimit = 12 * 1024 * 1024;
export type CredentialScope = (typeof scopes)[number];
export interface Config {
  apiUrl: string;
  keys: Partial<Record<CredentialScope, string>>;
  enableWrites: boolean;
  timeoutMs: number;
  transport: 'stdio' | 'http';
  port: number;
  host: '127.0.0.1' | '0.0.0.0';
  publicUrl?: string;
  mcpToken?: string;
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error('Invalid numeric configuration.');
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const url = new URL(env.RELIQUARY_API_URL ?? 'https://api.reliqua.ai');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(local && url.protocol === 'http:' && env.RELIQUARY_ALLOW_LOCAL_HTTP === 'true'))) {
    throw new Error('API URL must be an HTTPS origin; local HTTP requires explicit opt-in.');
  }
  if (env.RELIQUARY_ENABLE_WRITES !== undefined && !['true', 'false'].includes(env.RELIQUARY_ENABLE_WRITES)) {
    throw new Error('RELIQUARY_ENABLE_WRITES must be true or false.');
  }
  const keys: Config['keys'] = {};
  for (const scope of scopes) {
    const key = env[`RELIQUARY_${scope.toUpperCase()}_KEY`];
    if (key) {
      if (!/^rlq_[0-9a-f]{48}$/.test(key)) throw new Error(`Invalid ${scope} credential format.`);
      keys[scope] = key;
    }
  }
  const transport = env.RELIQUARY_TRANSPORT ?? 'stdio';
  if (transport !== 'stdio' && transport !== 'http') throw new Error('Unsupported transport.');
  const host = env.RELIQUARY_HTTP_HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '0.0.0.0') throw new Error('Unsupported bind address.');
  const config: Config = {
    apiUrl: url.origin, keys, transport, host,
    enableWrites: env.RELIQUARY_ENABLE_WRITES === 'true',
    timeoutMs: integer(env.RELIQUARY_TIMEOUT_MS, 30_000, 1000, 60_000),
    port: integer(env.RELIQUARY_PORT, 3000, 1, 65535),
  };
  if (env.RELIQUARY_PUBLIC_URL) {
    const publicUrl = new URL(env.RELIQUARY_PUBLIC_URL);
    if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password ||
        publicUrl.search || publicUrl.hash || !['/', '/mcp'].includes(publicUrl.pathname)) {
      throw new Error('Public URL must be an HTTPS origin or /mcp endpoint.');
    }
    config.publicUrl = publicUrl.origin;
  }
  if (transport === 'http') {
    const token = env.RELIQUARY_MCP_TOKEN;
    if (!token || !/^[A-Za-z0-9_-]{32,256}$/.test(token) || Object.values(keys).includes(token)) {
      throw new Error('HTTP requires a distinct MCP token of at least 32 characters.');
    }
    if (host === '0.0.0.0' && !config.publicUrl) throw new Error('External binding requires an HTTPS public URL and TLS proxy.');
    config.mcpToken = token;
  }
  return config;
}
