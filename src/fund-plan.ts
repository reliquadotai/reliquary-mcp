import { z } from 'zod';
import { publicKeyOf, ss58 } from './btauth.js';
import type { BtcliNames } from './wallet.js';

// Funding a service with gamma takes two chain transactions that this server never signs or submits:
// the coldkey mints gamma on the service's subnet into the agent hotkey's deposit, then the hotkey spends it
// at the service hotkey. The plan only returns the exact commands for their holders to run.

export const MIN_GAMMA = 0.1;
export const BITTENSOR_REQUIREMENT = 'bittensor>=11.3.5';

const amount = (max: number) => z.number().finite().positive().max(max);
/** Tool fields shared by the Reliquary and router fund plans. */
export const fundPlanFields = {
  amountGamma: amount(1_000_000).min(MIN_GAMMA).describe('Gamma to spend at the service: 1 gamma credits 1 USD. At least 0.1.'),
  amountTao: amount(1_000_000).optional().describe('TAO the coldkey burns to mint gamma. Omit to leave a placeholder; preview the minted amount with --dry-run.'),
  dailySpendCapGamma: amount(1_000_000).min(MIN_GAMMA).optional().describe('Daily spend cap of the deposit, at least 0.1 gamma. Defaults to amountGamma.'),
  hotkey: z.string().regex(/^5[1-9A-HJ-NP-Za-km-z]{46,47}$/).refine(v => publicKeyOf(v) !== undefined, 'Not an SS58 address.').optional()
    .describe('The agent hotkey (SS58) that spends and signs. Defaults to the wallet hotkey.'),
};

export interface FundPlanInput {
  netuid: number;
  serviceHotkey: string;
  amountGamma?: number | undefined;
  amountTao?: number | undefined;
  dailySpendCapGamma?: number | undefined;
  hotkey?: string | undefined;
  btcli?: BtcliNames | undefined;
}

/** A positive amount with at most nine decimals (gamma and TAO both have 10^9 units), without exponent. */
export function decimal(value: number): string {
  if (!Number.isFinite(value) || value <= 0 || value > 1e15) throw new RangeError('Invalid amount.');
  const fixed = value.toFixed(9).replace(/\.?0+$/, '');
  if (fixed === '0') throw new RangeError('Invalid amount.');
  return fixed;
}

/** POSIX shell quoting for names read from a local path. */
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function gammaFundPlan(input: FundPlanInput): Record<string, unknown> {
  const service = ss58(input.serviceHotkey);
  if (!service || !Number.isInteger(input.netuid) || input.netuid < 0 || input.netuid > 0xffff) throw new RangeError('Invalid service.');
  if (input.amountGamma !== undefined && input.amountGamma < MIN_GAMMA) throw new RangeError('At least 0.1 gamma.');
  if (input.dailySpendCapGamma !== undefined && input.dailySpendCapGamma < MIN_GAMMA) throw new RangeError('A daily spend cap is at least 0.1 gamma.');
  const hotkey = input.hotkey === undefined ? undefined : ss58(input.hotkey);
  if (input.hotkey !== undefined && !hotkey) throw new RangeError('Invalid hotkey.');
  const gamma = input.amountGamma === undefined ? '<GAMMA_AMOUNT>' : decimal(input.amountGamma);
  const cap = input.dailySpendCapGamma !== undefined ? decimal(input.dailySpendCapGamma) : input.amountGamma !== undefined ? gamma : '<DAILY_CAP_GAMMA>';
  const tao = input.amountTao === undefined ? '<TAO_AMOUNT>' : decimal(input.amountTao);
  const names = input.btcli ?? {};
  const signerFlags = [`-H ${names.hotkey ? shellQuote(names.hotkey) : '<HOTKEY_NAME>'}`,
    ...(names.wallet ? [`-w ${shellQuote(names.wallet)}`] : []), ...(names.walletPath ? [`--wallet-path ${shellQuote(names.walletPath)}`] : [])];
  const account = hotkey ?? '<AGENT_HOTKEY_SS58>';
  const mint = `btcli gamma mint --netuid ${input.netuid} --hotkey ${account} --amount-tao ${tao} --daily-spend-cap-gamma ${cap}`;
  const spend = `btcli gamma spend --netuid ${input.netuid} --service-hotkey ${service} --amount-gamma ${gamma} ${signerFlags.join(' ')}`;
  const placeholders = [mint, spend].join(' ').match(/<[A-Z0-9_]+>/g) ?? [];
  return {
    executed: false,
    netuid: input.netuid, serviceHotkey: service, hotkey: hotkey ?? null,
    amountGamma: input.amountGamma === undefined ? null : gamma,
    dailySpendCapGamma: cap.startsWith('<') ? null : cap,
    amountTao: input.amountTao === undefined ? null : tao,
    steps: [
      { step: 1, signer: 'coldkey', runBy: 'The human who owns the funding coldkey, in their own wallet. Never give a coldkey to an agent.',
        command: mint,
        notes: ['Mints at least 0.1 gamma: TAO buys this subnet\'s alpha, which is burned; 1 gamma is credited as 1 USD.',
          'The daily spend cap bounds what the hotkey can spend per day (at least 0.1 gamma; 0 pauses the deposit).',
          ...(input.amountTao === undefined ? ['Choose --amount-tao so the minted gamma covers the spend: --dry-run previews the quote, and the mint fails more than 5% below it.'] : []),
          'Add -w <coldkey wallet> when it is not the configured default wallet.'] },
      { step: 2, signer: 'hotkey', runBy: 'The holder of the agent hotkey. A spend pays no fee and needs no TAO.',
        command: spend,
        notes: ['-H is the hotkey\'s name in the wallet that holds its key file, not its address.',
          'A spend is at least 0.1 gamma unless it empties the deposit; one spend per hotkey and subnet can be pending at a time.',
          'The chain refuses a spend at a hotkey with no registered service on the subnet.'] },
    ],
    checks: [`btcli query services --netuid ${input.netuid}`, `btcli gamma show --netuid ${input.netuid} --hotkey ${account}`],
    requirements: { bittensor: BITTENSOR_REQUIREMENT, install: `pip install -U "${BITTENSOR_REQUIREMENT}"`, minimumGamma: '0.1' },
    placeholders: [...new Set(placeholders)],
    notes: [
      `Gamma minted on netuid ${input.netuid} is spent only at services of netuid ${input.netuid}: it cannot move to another subnet, another coldkey, or back to TAO.`,
      'Preview each transaction with --dry-run before submitting it.',
      'The service credits a spend after it reads it at a finalized block; check the balance before paying for requests.',
      'This server never runs these commands, never signs a chain transaction and never handles a coldkey, seed or phrase.',
    ],
  };
}
