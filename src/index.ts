#!/usr/bin/env node
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig, mcpMessageLimit } from './config.js';
import { buildServer } from './server.js';
import { createHttpServer } from './http.js';

try {
  const config = loadConfig();
  if (config.transport === 'stdio') {
    const handle = serveStdio(() => buildServer(config), {
      transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: mcpMessageLimit }),
    });
    const stop = () => { void handle.close().finally(() => { process.exitCode = 0; }); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  } else {
    const server = createHttpServer(config, () => buildServer(config));
    server.on('error', () => { process.stderr.write('HTTP server failed.\n'); process.exitCode = 1; });
    server.listen(config.port, config.host, () => { process.stderr.write('Reliquary MCP HTTP server ready.\n'); });
    const stop = () => {
      server.close();
      server.closeIdleConnections();
      const deadline = setTimeout(() => server.closeAllConnections(), 5000);
      deadline.unref();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  }
} catch {
  process.stderr.write('Reliquary MCP configuration is invalid. Check environment settings.\n');
  process.exitCode = 1;
}
