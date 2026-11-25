import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { ApiClient, ApiError } from './api.js';
import { publicKeyOf, ss58 } from './btauth.js';
import { ChainError, SubtensorReader } from './chain.js';
import type { Config } from './config.js';
import { fundPlanFields, gammaFundPlan } from './fund-plan.js';
import { registerRouterTools, routerToolNames, type RouterDeps } from './router.js';
import { RELIQUARY_NETUID } from './wallet.js';

// Paying Reliquary with gamma (SN81) and the router of every Gamma service on Bittensor.

export type GammaToolDeps = RouterDeps;
export const reliquaryGammaTools = ['reliquary_gamma_balance', 'reliquary_gamma_fund_plan'] as const;

/** Tool names this connection registers for Gamma payment and routing. */
export function gammaToolNames(config: Config): string[] {
  return [...reliquaryGammaTools, ...routerToolNames(config)];
}

/** What reliquary_connection reports: the authentication mode and, in wallet mode, the public hotkey only. */
export function gammaConnection(config: Config): Record<string, unknown> {
  return {
    authentication: config.wallet ? 'btauth/1' : 'workspace-keys',
    wallet: config.wallet
      ? { mode: 'btauth/1', hotkey: config.wallet.signer.ss58, crypto: config.wallet.signer.scheme, receiver: config.wallet.receiver,
          netuid: RELIQUARY_NETUID, scopes: 'all', note: 'Scoped Reliquary requests are signed by this hotkey instead of a workspace key; access follows what the hotkey has paid in gamma.' }
      : null,
    gamma: { netuid: RELIQUARY_NETUID, serviceHotkey: config.gamma.receiver, rpcOrigin: new URL(config.gamma.rpcUrl).origin },
  };
}

const outputSchema = z.object({ data: z.record(z.string(), z.unknown()) });
const address = z.string().regex(/^5[1-9A-HJ-NP-Za-km-z]{46,47}$/).refine(v => publicKeyOf(v) !== undefined, 'Not an SS58 address.');
const success = (data: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: { data } });
function failure(code: string, extra: Record<string, unknown> = {}) {
  const data = { error: { code, ...extra } };
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: { data } };
}

export function registerGammaTools(server: McpServer, config: Config, api: ApiClient, deps: GammaToolDeps = {}): void {
  const wallet = config.wallet;

  server.registerTool('reliquary_gamma_balance', {
    description: 'Read the Gamma balance Reliquary holds for a hotkey: GET /api/gamma/balance?hotkey= returns credited, used and remaining USD as decimal strings, and zeros for an unknown hotkey. Defaults to the wallet hotkey. Public read without signature or payment. A 404 means the route is not live yet.',
    inputSchema: z.strictObject({ hotkey: address.optional() }), outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ hotkey }, context) => {
    const account = hotkey ? ss58(hotkey) : wallet?.signer.ss58;
    if (!account) return failure('hotkey_required', { message: 'Pass a hotkey, or configure wallet mode with RELIQUARY_HOTKEY_FILE.' });
    try {
      const balance = await api.request({ path: `/api/gamma/balance?hotkey=${encodeURIComponent(account)}` }, context.mcpReq.signal);
      return success({ hotkey: account, live: true, balance });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        return success({ hotkey: account, live: false, status: 404, message: 'Reliquary has not opened its Gamma balance route yet. Do not spend gamma at its service hotkey until it is live.' });
      }
      const safe = error instanceof ApiError ? error : new ApiError('request_failed');
      return failure(safe.code, { ...(safe.status ? { status: safe.status } : {}), ...(safe.requestId ? { requestId: safe.requestId } : {}) });
    }
  });

  server.registerTool('reliquary_gamma_fund_plan', {
    description: 'Prepare, never run, the btcli commands that pay Reliquary with gamma on SN81: the coldkey mints gamma into the agent hotkey\'s deposit with a daily spend cap (btcli gamma mint), then the hotkey spends it at Reliquary\'s service hotkey without a fee (btcli gamma spend). At least 0.1 gamma; needs bittensor>=11.3.5. Size amountGamma from a reviewed quote. Also reads whether the service is registered on chain.',
    inputSchema: z.strictObject(fundPlanFields), outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args, context) => {
    let plan: Record<string, unknown>;
    try {
      plan = gammaFundPlan({ netuid: RELIQUARY_NETUID, serviceHotkey: config.gamma.receiver, ...args,
        ...(args.hotkey ? {} : wallet ? { hotkey: wallet.signer.ss58, btcli: wallet.btcli } : {}) });
    } catch (error) { return failure('invalid_amount', { message: error instanceof Error ? error.message : 'Invalid amount.' }); }
    let serviceRegistered: boolean | 'unknown' = 'unknown', serviceUrl: string | null = null;
    try {
      const reader = new SubtensorReader(config.gamma.rpcUrl, deps.rpcFetch ?? fetch);
      const service = await reader.service(RELIQUARY_NETUID, config.gamma.receiver, context.mcpReq.signal);
      serviceRegistered = service.url !== null && service.url !== '';
      serviceUrl = service.url || null;
    } catch (error) { if (!(error instanceof ChainError)) throw error; }
    return success({ service: { name: 'Reliquary', netuid: RELIQUARY_NETUID, serviceHotkey: config.gamma.receiver, registered: serviceRegistered, documentUrl: serviceUrl },
      ...plan,
      ...(serviceRegistered === true ? {} : { warning: serviceRegistered === false
        ? 'Reliquary\'s service hotkey has no registered service on SN81 yet, and the chain refuses a spend at it. Do not spend until btcli query services --netuid 81 lists it.'
        : 'Could not read the service registry: run btcli query services --netuid 81 before spending.' }) });
  });

  registerRouterTools(server, config, deps);
}
