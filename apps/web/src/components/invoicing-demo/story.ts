import type { Token } from '@/lib/checkout/api';
import { buildDemoAssetOptions } from '@/lib/demo-assets';
import type { InvoiceView } from '@/lib/invoices';

function demoToken(
  asset_id: string,
  symbol: string,
  blockchain: string,
  decimals = 6,
): Token {
  return {
    asset_id,
    symbol,
    blockchain,
    decimals,
    price_usd: null,
    popular: true,
  };
}

/** Same picker the invoice portal uses. USDC on NEAR is the one this film selects. */
export const INVOICE_USDC_NEAR = 'nep141:usdc.near';

export const INVOICE_ASSET_OPTIONS = buildDemoAssetOptions([
  demoToken(INVOICE_USDC_NEAR, 'USDC', 'near'),
  demoToken('eth:usdc', 'USDC', 'eth'),
  demoToken('base:usdc', 'USDC', 'base'),
  demoToken('arb:usdc', 'USDC', 'arb'),
  demoToken('sol:usdc', 'USDC', 'sol'),
  demoToken('bsc:usdc', 'USDC', 'bsc'),
  demoToken('eth:usdt', 'USDT', 'eth'),
  demoToken('nep141:usdt.near', 'USDT', 'near'),
  demoToken('tron:usdt', 'USDT', 'tron'),
  demoToken('eth', 'ETH', 'eth', 18),
  demoToken('near', 'NEAR', 'near', 24),
  demoToken('sol', 'SOL', 'sol', 9),
  demoToken('btc', 'BTC', 'btc', 8),
]);

export const BEATS = ['link', 'write', 'confirm', 'mail', 'letter', 'settle', 'bridge', 'paid'] as const;
export type InvoiceBeat = (typeof BEATS)[number];

export const CHAPTERS = [
  {
    id: 'contractor',
    label: 'Contractor',
    who: 'Claire Bennett',
    beats: ['link', 'write', 'confirm'],
  },
  {
    id: 'merchant',
    label: 'Merchant',
    who: 'Northline',
    beats: ['mail', 'letter', 'settle'],
  },
  {
    id: 'settlement',
    label: 'Settlement',
    who: 'NEAR Intents',
    beats: ['bridge', 'paid'],
  },
] as const;

export const STORY = {
  business: 'Northline',
  contractor: 'Claire Bennett',
  email: 'claire@bennett.studio',
  reference: 'NL-1842',
  due: '28 Nov 2026',
  link: 'invoice.usetendr.tech/northline',
  merchantEmail: 'finance@northline.com',
  wallet: 'claire.near',
  chain: 'NEAR',
  symbol: 'USDC',
  paySymbol: 'ETH',
  payChain: 'Ethereum',
  payHuman: '1.62',
  payBalance: '8.40',
  payBalanceAfter: '6.77',
  payFee: '0.01',
  decimals: 6,
  lines: [
    { description: 'November retainer', human: '3,200' },
    { description: 'Launch stills', human: '1,600' },
  ],
  totalHuman: '4,800',
  quoteMinutes: '14:32',
  tx: '7kQm…e4R2',
} as const;

const USDC = 1_000_000;

export const DEMO_INVOICE: InvoiceView = {
  id: 'inv_demo_northline',
  contractorName: STORY.contractor,
  email: STORY.email,
  reference: STORY.reference,
  description: STORY.lines[0].description,
  items: [
    { description: STORY.lines[0].description, amount: String(3200 * USDC) },
    { description: STORY.lines[1].description, amount: String(1600 * USDC) },
  ],
  dueDate: '2026-11-28',
  destination: STORY.wallet,
  destinationAsset: 'nep141:usdc.near',
  destinationChain: 'near',
  amount: String(4800 * USDC),
  decimals: STORY.decimals,
  symbol: STORY.symbol,
  status: 'open',
  verifiedAt: '2026-11-13T00:12:00.000Z',
  paidAt: null,
  createdAt: '2026-11-13T00:04:00.000Z',
  payout: null,
};

export const BEAT_COPY: Record<
  InvoiceBeat,
  { step: string; title: string; note: string; action: string }
> = {
  link: {
    step: 'Link',
    title: 'Claire opens Northline’s link',
    note: 'Contractor side only. She has no Tendr account. This is the public page Northline gives contractors.',
    action: 'Open link',
  },
  write: {
    step: 'Write',
    title: 'She writes the invoice',
    note: 'Name, email, USDC on NEAR, the two lines, and the wallet that should be paid.',
    action: 'Send invoice',
  },
  confirm: {
    step: 'Confirm',
    title: 'She confirms from her email',
    note: 'This is Claire’s inbox, not Northline’s. Nothing reaches the business until she confirms.',
    action: 'Verify and send',
  },
  mail: {
    step: 'Inbox',
    title: 'Northline’s email',
    note: 'Merchant side. A different person, a different inbox. Tendr has dropped the bill in finance@.',
    action: 'Open email',
  },
  letter: {
    step: 'Email',
    title: 'The bill is in the letter',
    note: 'Northline reads who is owed, how much, and which wallet. Payment comes out of the Tendr balance.',
    action: 'Pay from wallet',
  },
  settle: {
    step: 'Sign',
    title: 'Quote, then the passkey',
    note: 'Northline pays in ETH on Ethereum. Claire still receives USDC on NEAR. Signing starts that swap.',
    action: 'Sign and pay',
  },
  bridge: {
    step: 'Bridge',
    title: 'ETH becomes USDC on NEAR',
    note: 'Northline sends ETH on Ethereum. NEAR Intents delivers USDC to claire.near.',
    action: 'Show settled',
  },
  paid: {
    step: 'Paid',
    title: 'Both sides are settled',
    note: 'Claire has 4,800 USDC on NEAR. Northline’s ETH balance has dropped. The bridge stays lit.',
    action: 'Replay',
  },
};
