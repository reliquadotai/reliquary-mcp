import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { createGenerationClient, createGenerationTransport, GenerationApiError, generationRequests, type GenerationOrderDetail } from '@reliquary/api';
import { downloadDelivery, uploadFile } from '@reliquary/api/node';
import { ApiClient, ApiError, withRequestSlot } from './api.js';
import type { Config } from './config.js';

// Batch tools that touch the customer's disk (upload a JSONL, write a delivery) run only in a local stdio
// process: a hosted HTTP connector cannot read or write the customer's files. No tool returns file contents.
const outputSchema = z.object({ data: z.record(z.string(), z.unknown()) });
const id = z.string().regex(/^[\w-]{1,64}$/);
const approved = z.literal(true).describe('Set only after the user explicitly approves this exact action.');
const localPath = z.string().min(1).max(4096).refine(v => !/[\x00]/.test(v), 'Invalid path.');

export type BatchToolDeps = { transport?: ReturnType<typeof createGenerationTransport> };
export type BatchTool = { name: string; write: boolean; local: boolean };
export const batchTools: BatchTool[] = [
  { name: 'reliquary_batch_upload', write: true, local: true },
  { name: 'reliquary_batch_files', write: false, local: false },
  { name: 'reliquary_batch_download', write: false, local: true },
];

/** The batch tools this connection offers: an orders key, writes for uploads, a local process for disk access. */
export function availableBatchTools(config: Config): BatchTool[] {
  if (!config.keys.orders) return [];
  return batchTools.filter(tool => (!tool.write || config.enableWrites) && (!tool.local || config.transport === 'stdio'));
}

function failure(error: unknown) {
  const safe = error instanceof ApiError ? { code: error.code, ...(error.status ? { status: error.status } : {}), ...(error.requestId ? { requestId: error.requestId } : {}) }
    : error instanceof GenerationApiError ? { code: error.code, ...(error.status ? { status: error.status } : {}), ...(error.requestId ? { requestId: error.requestId } : {}),
      ...(error.message && !error.message.startsWith('API request failed') ? { message: error.message.slice(0, 300) } : {}) }
    : { code: 'request_failed', ...(error instanceof Error ? { message: error.message.slice(0, 300) } : {}) };
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: safe }) }], structuredContent: { data: { error: safe } } };
}
const success = (data: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: { data } });

export function registerBatchTools(server: McpServer, config: Config, api: ApiClient, deps: BatchToolDeps = {}): void {
  const offered = new Set(availableBatchTools(config).map(tool => tool.name));
  const transport = () => deps.transport ?? createGenerationTransport({ origin: config.apiUrl, apiKey: config.keys.orders!, timeoutMs: config.timeoutMs });
  const order = async (orderId: string, signal?: AbortSignal) =>
    (await api.request({ ...generationRequests('key').detail(orderId), scope: 'orders', generationResponse: 'order', generationExpected: { id: orderId } }, signal))
      ['order'] as GenerationOrderDetail;

  if (offered.has('reliquary_batch_upload'))
    server.registerTool('reliquary_batch_upload', {
      description: 'Upload a local OpenAI Batch JSONL file (at most 200 MB) in resumable parts, after the user confirms the data rights and approves the upload. Returns the file record and id for reliquary_batch_quote; never returns contents. To finish an interrupted upload pass its fileId.',
      inputSchema: z.strictObject({ path: localPath.describe('The .jsonl file the user named.'), fileId: z.string().regex(/^file-[\w-]{1,80}$/).optional(),
        rightsConfirmed: z.literal(true).describe('The user confirmed they may send this data.'), approveExecution: approved }),
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async (args, context) => {
      try {
        const path = resolve(args.path);
        if (!path.toLowerCase().endsWith('.jsonl')) throw new Error('Choose a .jsonl batch file.');
        const info = await stat(path);
        if (!info.isFile()) throw new Error('The path is not a file.');
        const file = await withRequestSlot(() => uploadFile(transport(), path, { ...(args.fileId ? { fileId: args.fileId } : {}), signal: context.mcpReq.signal }));
        return success({ file });
      } catch (error) { return failure(error); }
    });

  if (offered.has('reliquary_batch_files'))
    server.registerTool('reliquary_batch_files', {
      description: 'List the delivered files of an owned batch order: names, sizes, sha256 and download URLs only, never contents; an evaluation on a file also returns its evaluation summary and lists delivery evaluation (graded.parquet, report.json, manifest.json). Use reliquary_batch_download (local connection) to save them, or the bounded generation_download for a preview.',
      inputSchema: z.strictObject({ orderId: id }), outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async (args, context) => {
      try {
        const detail = await order(args.orderId, context.mcpReq.signal);
        const files = detail.deliveries.flatMap(delivery => delivery.files.map(file => ({
          deliveryId: delivery.delivery_id, name: file.name, size: file.size, sha256: file.sha256, url: new URL(file.url, config.apiUrl).href })));
        return success({ orderId: detail.id, status: detail.status, ...('evaluation' in detail && detail.evaluation ? { evaluation: detail.evaluation } : {}), files });
      } catch (error) { return failure(error); }
    });

  if (offered.has('reliquary_batch_download'))
    server.registerTool('reliquary_batch_download', {
      description: 'Save every delivered file of an owned batch order under a local directory the user chose (<directory>/<delivery id>/<file>), resuming partial files and verifying files whose sha256 is supplied. Returns paths, sizes and verification, never contents.',
      inputSchema: z.strictObject({ orderId: id, directory: localPath }), outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async (args, context) => {
      try {
        return await withRequestSlot(async () => {
          const signal = context.mcpReq.signal;
          const client = transport();
          const detail = await createGenerationClient(client.request).detail(args.orderId, signal);
          const files = await downloadDelivery(client, detail, resolve(args.directory), { signal });
          return success({ orderId: detail.id, status: detail.status, directory: resolve(args.directory), files });
        });
      } catch (error) { return failure(error); }
    });
}
