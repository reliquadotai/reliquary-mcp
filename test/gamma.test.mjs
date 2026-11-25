import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { compactToU8a, u8aConcat, u8aToHex } from '@polkadot/util';
import { encodeAddress, sr25519PairFromSeed } from '@polkadot/util-crypto';
import { ApiClient } from '../dist/api.js';
import { serviceStorageKey } from '../dist/chain.js';
import { loadConfig } from '../dist/config.js';
import { decimal, gammaFundPlan, shellQuote } from '../dist/fund-plan.js';
import { buildServer } from '../dist/server.js';
import { DEFAULT_GAMMA_RECEIVER } from '../dist/wallet.js';

const SEED = '0x' + '6c'.repeat(32);
const PAIR = sr25519PairFromSeed(Buffer.from(SEED.slice(2), 'hex'));
const ME = encodeAddress(PAIR.publicKey, 42);
const OTHER = encodeAddress(sr25519PairFromSeed(Buffer.alloc(32, 7)).publicKey, 42);

async function wallet(walletName = 'agent', hotkeyName = 'reliquary', env = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-gamma-'));
  const dir = join(root, 'wallets', walletName, 'hotkeys');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, hotkeyName), JSON.stringify({ secretSeed: SEED, ss58Address: ME }));
  return { config: loadConfig({ RELIQUARY_HOTKEY_FILE: join(dir, hotkeyName), ...env }), walletPath: join(root, 'wallets'), close: () => rm(root, { recursive: true, force: true }) };
}

function rpc({ registered, fail = false } = {}) {
  const head = '0x' + 'cd'.repeat(32);
  const storage = new Map(registered ? [[serviceStorageKey(81, registered.hotkey), u8aToHex(u8aConcat(compactToU8a(registered.url.length), new TextEncoder().encode(registered.url)))]] : []);
  const calls = [];
  return { calls, fetch: async (url, init) => {
    if (fail) return new Response('down', { status: 503 });
    const { id, method, params } = JSON.parse(init.body);
    calls.push([method, params]);
    return Response.json({ jsonrpc: '2.0', id, result: method === 'chain_getFinalizedHead' ? head : storage.get(params[0]) ?? null });
  } };
}

async function connect(config, fetcher, deps = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer(config, new ApiClient(config, fetcher), {}, deps);
  await server.connect(serverTransport);
  const client = new Client({ name: 'gamma-test', version: '1.0.0' });
  await client.connect(clientTransport);
  return { call: (name, args = {}) => client.callTool({ name, arguments: args }), client, close: async () => { await client.close(); await server.close(); } };
}

test('reliquary_gamma_balance reads the public balance route and treats a 404 as not live yet', async () => {
  const w = await wallet();
  const seen = [];
  let mode = 'missing';
  const fetcher = async (url, init) => {
    seen.push({ url: url.href, headers: new Headers(init.headers) });
    if (mode === 'missing') return Response.json({ error: { code: 'not_found' } }, { status: 404 });
    if (mode === 'down') return new Response('oops', { status: 503 });
    return Response.json({ hotkey: url.searchParams.get('hotkey'), credited_usd: '5.000000', used_usd: '0.250000', remaining_usd: '4.750000' });
  };
  const session = await connect(w.config, fetcher);
  try {
    const missing = await session.call('reliquary_gamma_balance');
    assert.equal(missing.isError, undefined);
    assert.deepEqual({ ...missing.structuredContent.data, message: undefined }, { hotkey: ME, live: false, status: 404, message: undefined });
    assert.equal(seen.at(-1).url, `https://api.reliqua.ai/api/gamma/balance?hotkey=${ME}`);
    assert.equal(seen.at(-1).headers.get('Authorization'), null);
    assert.equal(seen.at(-1).headers.get('X-Bittensor-Signature'), null, 'a public read is not signed');
    mode = 'live';
    const live = (await session.call('reliquary_gamma_balance', { hotkey: OTHER })).structuredContent.data;
    assert.deepEqual(live, { hotkey: OTHER, live: true, balance: { hotkey: OTHER, credited_usd: '5.000000', used_usd: '0.250000', remaining_usd: '4.750000' } });
    mode = 'down';
    const down = await session.call('reliquary_gamma_balance');
    assert.equal(down.isError, true);
    assert.equal(down.structuredContent.data.error.status, 503);
    assert.equal((await session.call('reliquary_gamma_balance', { hotkey: '0x1234' })).isError, true);
  } finally { await session.close(); await w.close(); }
  const anonymous = await connect(loadConfig({}), fetcher);
  try {
    const result = await anonymous.call('reliquary_gamma_balance');
    assert.equal(result.structuredContent.data.error.code, 'hotkey_required');
    const { tools } = await anonymous.client.listTools();
    for (const name of ['reliquary_gamma_balance', 'reliquary_gamma_fund_plan']) assert.equal(tools.find(t => t.name === name).annotations.readOnlyHint, true);
  } finally { await anonymous.close(); }
});

test('reliquary_gamma_fund_plan returns the exact mint and spend commands without running them', async () => {
  const w = await wallet();
  const chain = rpc({ registered: { hotkey: DEFAULT_GAMMA_RECEIVER, url: 'https://api.reliqua.ai/services.json' } });
  const session = await connect(w.config, () => { throw new Error('no API call expected'); }, { rpcFetch: chain.fetch });
  try {
    const plan = (await session.call('reliquary_gamma_fund_plan', { amountGamma: 5, amountTao: 0.05, dailySpendCapGamma: 10 })).structuredContent.data;
    assert.equal(plan.executed, false);
    assert.deepEqual(plan.service, { name: 'Reliquary', netuid: 81, serviceHotkey: DEFAULT_GAMMA_RECEIVER, registered: true, documentUrl: 'https://api.reliqua.ai/services.json' });
    assert.equal(plan.steps[0].command, `btcli gamma mint --netuid 81 --hotkey ${ME} --amount-tao 0.05 --daily-spend-cap-gamma 10`);
    assert.equal(plan.steps[1].command, `btcli gamma spend --netuid 81 --service-hotkey ${DEFAULT_GAMMA_RECEIVER} --amount-gamma 5 -H reliquary -w agent --wallet-path ${w.walletPath}`);
    assert.deepEqual(plan.requirements, { bittensor: 'bittensor>=11.3.5', install: 'pip install -U "bittensor>=11.3.5"', minimumGamma: '0.1' });
    assert.ok(plan.steps[0].notes.some(note => note.includes('0.1 gamma')) && plan.steps[1].notes.some(note => note.includes('0.1 gamma')));
    assert.ok(plan.notes.some(note => note.includes('netuid 81') && note.includes('cannot move to another subnet')));
    assert.equal(plan.warning, undefined);
    assert.deepEqual(chain.calls.map(([method]) => method), ['chain_getFinalizedHead', 'state_getStorage']);
    assert.equal(chain.calls[1][1][0], serviceStorageKey(81, DEFAULT_GAMMA_RECEIVER));
    const sized = (await session.call('reliquary_gamma_fund_plan', { amountGamma: 1.2345678901 })).structuredContent.data;
    assert.equal(sized.steps[0].command, `btcli gamma mint --netuid 81 --hotkey ${ME} --amount-tao <TAO_AMOUNT> --daily-spend-cap-gamma 1.23456789`);
    assert.ok(sized.steps[0].notes.some(note => note.includes('--dry-run')));
    for (const args of [{ amountGamma: 0.05 }, { amountGamma: 1, dailySpendCapGamma: 0.01 }, { amountGamma: -1 }, { amountGamma: 1, amountTao: 0 }, { amountGamma: 1, seed: SEED }]) {
      assert.equal((await session.call('reliquary_gamma_fund_plan', args)).isError, true, JSON.stringify(args));
    }
  } finally { await session.close(); await w.close(); }
});

test('the fund plan warns until the service is registered, honours a configured receiver and quotes local names', async () => {
  const unregistered = rpc();
  const anonymous = await connect(loadConfig({}), () => { throw new Error('no API call expected'); }, { rpcFetch: unregistered.fetch });
  try {
    const plan = (await anonymous.call('reliquary_gamma_fund_plan', { amountGamma: 2 })).structuredContent.data;
    assert.equal(plan.service.registered, false);
    assert.match(plan.warning, /no registered service/);
    assert.equal(plan.steps[0].command, 'btcli gamma mint --netuid 81 --hotkey <AGENT_HOTKEY_SS58> --amount-tao <TAO_AMOUNT> --daily-spend-cap-gamma 2');
    assert.equal(plan.steps[1].command, `btcli gamma spend --netuid 81 --service-hotkey ${DEFAULT_GAMMA_RECEIVER} --amount-gamma 2 -H <HOTKEY_NAME>`);
  } finally { await anonymous.close(); }
  const down = await connect(loadConfig({ RELIQUARY_GAMMA_RECEIVER: OTHER }), () => { throw new Error('no API call expected'); }, { rpcFetch: rpc({ fail: true }).fetch });
  try {
    const plan = (await down.call('reliquary_gamma_fund_plan', { amountGamma: 2, hotkey: ME })).structuredContent.data;
    assert.equal(plan.service.registered, 'unknown');
    assert.match(plan.warning, /btcli query services --netuid 81/);
    assert.equal(plan.serviceHotkey, OTHER);
    assert.match(plan.steps[1].command, new RegExp(`--service-hotkey ${OTHER} `));
  } finally { await down.close(); }
  const w = await wallet('my wallet', "agent's key");
  const quoted = await connect(w.config, () => { throw new Error('no API call expected'); }, { rpcFetch: unregistered.fetch });
  try {
    const plan = (await quoted.call('reliquary_gamma_fund_plan', { amountGamma: 3 })).structuredContent.data;
    assert.ok(plan.steps[1].command.endsWith(`-H 'agent'\\''s key' -w 'my wallet' --wallet-path ${w.walletPath}`), plan.steps[1].command);
  } finally { await quoted.close(); await w.close(); }
});

test('fund plan amounts are exact decimals and the builder refuses what the chain would refuse', () => {
  assert.deepEqual([0.1, 5, 10, 1.5, 0.123456789, 1.0000000004, 12345.6789].map(decimal), ['0.1', '5', '10', '1.5', '0.123456789', '1', '12345.6789']);
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e-10]) assert.throws(() => decimal(bad));
  assert.equal(shellQuote('agent_1.key-2'), 'agent_1.key-2');
  assert.equal(shellQuote('a b'), "'a b'");
  assert.equal(shellQuote('$(rm -rf /)'), "'$(rm -rf /)'");
  assert.throws(() => gammaFundPlan({ netuid: 81, serviceHotkey: DEFAULT_GAMMA_RECEIVER, amountGamma: 0.09 }), /0.1 gamma/);
  assert.throws(() => gammaFundPlan({ netuid: 81, serviceHotkey: DEFAULT_GAMMA_RECEIVER, amountGamma: 1, dailySpendCapGamma: 0.05 }), /0.1 gamma/);
  assert.throws(() => gammaFundPlan({ netuid: 70000, serviceHotkey: DEFAULT_GAMMA_RECEIVER }), /Invalid service/);
  assert.throws(() => gammaFundPlan({ netuid: 81, serviceHotkey: 'nope' }), /Invalid service/);
  const open = gammaFundPlan({ netuid: 81, serviceHotkey: DEFAULT_GAMMA_RECEIVER });
  assert.deepEqual(open.placeholders, ['<AGENT_HOTKEY_SS58>', '<TAO_AMOUNT>', '<DAILY_CAP_GAMMA>', '<GAMMA_AMOUNT>', '<HOTKEY_NAME>']);
  assert.equal(open.amountGamma, null);
});
