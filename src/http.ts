import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createMcpHandler, type McpServer } from '@modelcontextprotocol/server';
import { hostHeaderValidation, toNodeHandler } from '@modelcontextprotocol/node';
import type { Config } from './config.js';
import { mcpMessageLimit } from './config.js';

export function createHttpServer(config: Config, factory: () => McpServer): Server {
  if (!config.mcpToken) throw new Error('HTTP credential is required.');
  const expected = Buffer.from(`Bearer ${config.mcpToken}`);
  const handler = createMcpHandler(factory, { maxRequestBodySize: mcpMessageLimit });
  const nodeHandler = toNodeHandler(handler, { maxRequestBodySize: mcpMessageLimit });
  const allowedHosts = ['localhost', '127.0.0.1', ...(config.publicUrl ? [new URL(config.publicUrl).hostname] : [])];
  const validateHost = hostHeaderValidation(allowedHosts);
  let active = 0;
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!validateHost(req, res)) return;
    if (req.headers.origin) {
      const allowed = config.publicUrl ? [config.publicUrl] : [`http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`];
      if (!allowed.includes(req.headers.origin)) { res.writeHead(403).end(); return; }
    }
    if (req.url === '/healthz' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end('{"status":"ok"}'); return;
    }
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    const actual = Buffer.from(req.headers.authorization ?? '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="reliquary-mcp"');
      res.writeHead(401).end(); return;
    }
    // ponytail: per-process admission limit; use proxy rate limits for public deployments.
    if (active >= 32) { res.setHeader('Retry-After', '1'); res.writeHead(429).end(); return; }
    active++;
    res.once('close', () => { active--; });
    void nodeHandler(req as Parameters<typeof nodeHandler>[0], res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end(); else res.destroy();
    });
  });
  server.requestTimeout = 65_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.on('close', () => { void handler.close(); });
  return server;
}
