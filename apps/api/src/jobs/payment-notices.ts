// Store emails (WooCommerce plugin spec §8): "You got paid" (`payment_received`) on
// `payment.succeeded`, for every payment of the store whatever created it, and "Refund sent"
// (`refund_sent`) on `refund.sent`. Both go to the store's verified notification email, else its
// owners (merchants/store-notices.ts); `payment_received` only while `payment_emails_enabled`.
// Test mode mails too, with "[Test]" in the subject.
//
// Everything in the mail is read from the store's own rows — the payment, its session, quote and
// fee lines, the refund — never from the event payload, which is used for the row id only.
// Copy is plain merchant language: "network fee", never internal words.
//
// Handlers run at least once per event: each send is claimed in `event_notices` per (event,
// template, recipient), so a replay mails nobody twice. A retry re-reads the recipients
// (`storeNoticeTarget`) and the switch: a mail that failed before an address change goes to the
// address in effect at the retry, and none goes out if "You got paid" was turned off meanwhile.
import { Prisma, type Event } from '@prisma/client';
import { env } from '../env.js';
import { scopedDb } from '../db/scoped.js';
import { minorUnits } from '../checkout/fx.js';
import type { TokenInfo } from '../checkout/oneclick/index.js';
import { getPayment } from '../checkout/payment-views.js';
import { tokenInfo } from '../checkout/tokens.js';
import { AppError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { oneLine, sendOncePerEvent, storeNoticeTarget } from '../merchants/store-notices.js';
import { handlerNamesFor, registerEventHandler } from './handlers.js';

const D = Prisma.Decimal;

export type NoticeDeps = {
  /** An asset's symbol, decimals and chain (the mode's 1Click token list). */
  token: (livemode: boolean, assetId: string) => Promise<TokenInfo>;
};
const DEFAULT_DEPS: NoticeDeps = { token: tokenInfo };

type Payload = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

// ─── formatting ──────────────────────────────────────────────────────────────

type Asset = { symbol: string; decimals: number; chain: string } | null;

/** The asset's display info; null when the provider no longer lists it (shown in base units). */
async function assetOf(deps: NoticeDeps, livemode: boolean, assetId: string): Promise<Asset> {
  try {
    const t = await deps.token(livemode, assetId);
    return { symbol: t.symbol, decimals: t.decimals, chain: t.blockchain };
  } catch (err) {
    if (err instanceof AppError && err.code === 'UNSUPPORTED_ASSET') return null;
    throw err; // provider unavailable: retried, so the mail carries real symbols
  }
}

/** Base units → a decimal string without trailing zeros (`48750000`, 6 → `48.75`). */
export function decimalAmount(units: Prisma.Decimal | string, decimals: number): string {
  return new D(units).div(new D(10).pow(decimals)).toFixed();
}

const amountText = (units: Prisma.Decimal | string, asset: Asset, assetId: string) =>
  asset
    ? `${decimalAmount(units, asset.decimals)} ${asset.symbol}`
    : `${new D(units).toFixed(0)} base units of ${assetId}`;

const CHAIN_NAMES: Readonly<Record<string, string>> = {
  near: 'NEAR',
  eth: 'Ethereum',
  base: 'Base',
  arb: 'Arbitrum',
  arbitrum: 'Arbitrum',
  pol: 'Polygon',
  polygon: 'Polygon',
  bsc: 'BNB Chain',
  op: 'Optimism',
  optimism: 'Optimism',
  avax: 'Avalanche',
  avalanche: 'Avalanche',
  sol: 'Solana',
  tron: 'Tron',
  btc: 'Bitcoin',
};
const chainName = (chain: string) =>
  Object.hasOwn(CHAIN_NAMES, chain)
    ? CHAIN_NAMES[chain]!
    : chain.charAt(0).toUpperCase() + chain.slice(1);

// Mirrors apps/web/src/lib/payments.ts `explorerTxUrl`: test mode has NEAR testnet only (other
// test-mode chains are simulated).
const EXPLORERS: Readonly<Record<string, { live: string; test: string | null }>> = {
  near: { live: 'https://nearblocks.io/txns/', test: 'https://testnet.nearblocks.io/txns/' },
  eth: { live: 'https://etherscan.io/tx/', test: null },
  base: { live: 'https://basescan.org/tx/', test: null },
  arb: { live: 'https://arbiscan.io/tx/', test: null },
  arbitrum: { live: 'https://arbiscan.io/tx/', test: null },
  pol: { live: 'https://polygonscan.com/tx/', test: null },
  polygon: { live: 'https://polygonscan.com/tx/', test: null },
  bsc: { live: 'https://bscscan.com/tx/', test: null },
  op: { live: 'https://optimistic.etherscan.io/tx/', test: null },
  optimism: { live: 'https://optimistic.etherscan.io/tx/', test: null },
  avax: { live: 'https://snowtrace.io/tx/', test: null },
  avalanche: { live: 'https://snowtrace.io/tx/', test: null },
  sol: { live: 'https://solscan.io/tx/', test: null },
  tron: { live: 'https://tronscan.org/#/transaction/', test: null },
  btc: { live: 'https://mempool.space/tx/', test: null },
};

export function explorerTxUrl(chain: string | null, hash: string, livemode: boolean): string {
  if (!chain || !Object.hasOwn(EXPLORERS, chain)) return '';
  const base = livemode ? EXPLORERS[chain]!.live : EXPLORERS[chain]!.test;
  return base ? `${base}${encodeURIComponent(hash)}` : '';
}

const FEE_LABELS: Readonly<Record<string, string>> = {
  tendr_fee: 'Tendr fee',
  oneclick_fee: '1Click fee and spread',
  network_fee: 'Network fee (estimated)',
  gas_reimbursement: 'Network fee you sponsored',
  other: 'Other fee',
};

/**
 * The payment's dashboard page, naming its store and mode (`?store=&mode=`) so the dashboard opens
 * them; it switches only for a member of that store.
 */
export function dashboardPaymentUrl(paymentId: string, merchantId: string, livemode: boolean) {
  const url = new URL(`/dashboard/payments/${encodeURIComponent(paymentId)}`, env().WEB_URL);
  url.searchParams.set('store', merchantId);
  url.searchParams.set('mode', livemode ? 'live' : 'test');
  return url.toString();
}

/** One line (no CR/LF or control characters from store-supplied names and refs). */
const subjectFor = (livemode: boolean, subject: string) =>
  oneLine(livemode ? subject : `[Test] ${subject}`);

const orderLabel = (externalRef: string | null) =>
  externalRef ? `order ${oneLine(externalRef)}` : 'an order';

// ─── payment_received ────────────────────────────────────────────────────────

/** `payment.succeeded` → `payment_received` to the store's notice address (when enabled). */
export async function onPaymentReceivedNotice(
  e: Event,
  deps: NoticeDeps = DEFAULT_DEPS,
): Promise<void> {
  if (!e.merchantId || e.livemode === null) return;
  const paymentId = str((e.payload as Payload | null)?.payment_id) || e.aggregateId;
  const target = await storeNoticeTarget(e.merchantId);
  if (!target || !target.paymentEmailsEnabled || target.recipients.length === 0) return;

  const ctx = { merchantId: e.merchantId, livemode: e.livemode };
  const db = scopedDb(ctx);
  const p = await getPayment(db, paymentId);
  const s = await db.session.findFirstOrThrow({
    where: { id: p.session_id },
    select: {
      amount: true,
      amountCurrency: true,
      originalAmount: true,
      originalCurrency: true,
      fxRate: true,
      fxSource: true,
      fxAsOf: true,
      payerNote: true,
      // One join, with the session: the link's title for the subject and first line.
      paymentLink: { select: { title: true } },
    },
  });
  if (!p.settlement.amount_out) {
    // A `payment.succeeded` always comes with the settled amount; never mail a guess.
    log('error', 'payment_received skipped: payment has no settled amount', { paymentId });
    return;
  }

  const settlement = await assetOf(deps, e.livemode, p.settlement.asset);
  const source = await assetOf(deps, e.livemode, p.source.asset);
  const received = amountText(p.settlement.amount_out, settlement, p.settlement.asset);
  const amountReceived = settlement
    ? decimalAmount(p.settlement.amount_out, settlement.decimals)
    : p.settlement.amount_out;

  const usdLike = s.amountCurrency === 'USD';
  const sessionTotal = usdLike
    ? `${s.amount.toFixed(2)} USD`
    : s.amountCurrency === p.settlement.asset && settlement
      ? `${s.amount.toFixed()} ${settlement.symbol}`
      : `${s.amount.toFixed()} ${s.amountCurrency}`;
  const fx =
    s.originalAmount && s.originalCurrency && s.fxRate
      ? {
          total: `${s.originalAmount.toFixed(minorUnits(s.originalCurrency) ?? 2)} ${s.originalCurrency}`,
          rate: `1 USD = ${s.fxRate.toFixed()} ${s.originalCurrency}`,
          source: s.fxSource ?? '',
          asOf: s.fxAsOf ? s.fxAsOf.toISOString() : '',
        }
      : null;
  const orderTotal = fx ? `${fx.total} (${sessionTotal})` : sessionTotal;

  const paidChain = p.source.chain ?? source?.chain ?? '';
  const paidWith = `${amountText(p.received.amount, source, p.source.asset)}${
    paidChain ? ` on ${chainName(paidChain)}` : ''
  }`;

  // "Network fee: paid by you ($0.05)" (sponsored, rounded up to the cent) or "paid by the shopper".
  const networkFee = p.network_fee
    ? p.network_fee.paid_by === 'merchant'
      ? `paid by you ($${new D(p.network_fee.usd).toDecimalPlaces(2, D.ROUND_UP).toFixed(2)})`
      : 'paid by the shopper'
    : null;

  const feeLines = p.fees.map((f) => {
    const label = FEE_LABELS[f.kind] ?? FEE_LABELS.other!;
    const value = f.amount_usd
      ? `$${new D(f.amount_usd).toFixed(2)}`
      : amountText(f.amount, null, f.asset);
    return `${label}: ${value}`;
  });

  const tx = p.transactions.settlement ?? p.transactions.origin;
  const txUrl = tx ? explorerTxUrl(tx.chain, tx.hash, e.livemode) : '';
  const dashboardUrl = dashboardPaymentUrl(p.id, e.merchantId, e.livemode);
  // A payment through a payment link is named for the link; the payer's note is quoted as plain
  // text (every line behind "> "), never as markup or a link.
  const linkTitle = s.paymentLink ? oneLine(s.paymentLink.title) : null;
  const payerNote = s.payerNote ?? '';
  const order = linkTitle ? `via ${linkTitle}` : `for ${orderLabel(p.external_ref)}`;

  const subject = subjectFor(e.livemode, `You got paid ${received} ${order}`);
  const text = [
    `${target.name} received ${received} ${order}.`,
    ...(payerNote
      ? ['Note from the payer:', ...payerNote.split(/\r?\n/).map((l) => `> ${l}`)]
      : []),
    ...(e.livemode ? [] : ['This is a test payment: no real money moved.']),
    '',
    `Order total: ${orderTotal}`,
    ...(fx ? [`Rate: ${fx.rate}${fx.source ? ` (${fx.source})` : ''}`] : []),
    `Paid with: ${paidWith}`,
    ...(networkFee ? [`Network fee: ${networkFee}`] : []),
    '',
    'Fees:',
    ...(feeLines.length > 0 ? feeLines.map((l) => `- ${l}`) : ['- None']),
    '',
    tx
      ? `Transaction: ${txUrl || `${tx.hash} on ${chainName(tx.chain ?? '')}`}`
      : 'Transaction: not available yet',
    `See the payment: ${dashboardUrl}`,
  ].join('\n');

  await sendOncePerEvent(e.id, 'payment_received', target.recipients, {
    subject,
    text,
    data: {
      store_name: target.name,
      livemode: String(e.livemode),
      payment_id: p.id,
      external_ref: p.external_ref ?? '',
      payment_link_title: linkTitle ?? '',
      payer_note: payerNote,
      amount_received: amountReceived,
      settlement_symbol: settlement?.symbol ?? p.settlement.asset,
      order_total: orderTotal,
      original_amount: fx?.total ?? '',
      fx_rate: fx?.rate ?? '',
      fx_source: fx?.source ?? '',
      fx_as_of: fx?.asOf ?? '',
      paid_with: paidWith,
      network_fee: networkFee ?? '',
      fees: feeLines.join('\n'),
      tx_hash: tx?.hash ?? '',
      tx_url: txUrl,
      dashboard_url: dashboardUrl,
    },
  });
}

// ─── refund_sent ─────────────────────────────────────────────────────────────

const REFUND_REASONS: Readonly<Record<string, string>> = {
  merchant: 'refund from your store',
  overpaid: 'return of an overpayment',
  late: 'return of a late payment',
  expired: 'return of a payment after the checkout expired',
  underpaid: 'return of an underpayment',
  failed: 'return of a payment that could not complete',
  sanctions: 'return of a held payment',
};

/** `refund.sent` → `refund_sent` to the store's notice address (refund notices are always on). */
export async function onRefundSentNotice(e: Event, deps: NoticeDeps = DEFAULT_DEPS): Promise<void> {
  if (!e.merchantId || e.livemode === null) return;
  const refundId = str((e.payload as Payload | null)?.refund_id) || e.aggregateId;
  const target = await storeNoticeTarget(e.merchantId);
  if (!target || target.recipients.length === 0) return;

  const db = scopedDb({ merchantId: e.merchantId, livemode: e.livemode });
  const r = await db.refund.findFirst({ where: { id: refundId } });
  if (!r || r.status !== 'confirmed') {
    log('error', 'refund_sent skipped: refund not found or not sent', { refundId });
    return;
  }
  const payment = await db.payment.findFirstOrThrow({
    where: { id: r.paymentId },
    select: { id: true, session: { select: { externalRef: true } } },
  });
  const asset = await assetOf(deps, e.livemode, r.assetId);
  // A store refund's `amount` includes the network fee the store pays; an automatic return's
  // `amount` is already net of it.
  const fee = r.returnFee ?? new D(0);
  const toCustomer = r.reason === 'merchant' ? r.amount.minus(fee) : r.amount;
  const sent = amountText(toCustomer, asset, r.assetId);
  const order = orderLabel(payment.session.externalRef);
  // `refundTxHash` is always the NEAR transaction that executed the refund proposal
  // (checkout/refunds.ts), whatever chain the customer's address is on: link it on NEAR.
  const txUrl = r.refundTxHash ? explorerTxUrl('near', r.refundTxHash, e.livemode) : '';
  const dashboardUrl = dashboardPaymentUrl(payment.id, e.merchantId, e.livemode);
  const reason = REFUND_REASONS[r.reason] ?? 'return to the customer';
  const to = r.destinationChain
    ? `to your customer's ${chainName(r.destinationChain)} address`
    : 'to your customer';

  const subject = subjectFor(e.livemode, `Refund sent: ${sent} for ${order}`);
  const text = [
    `${target.name} sent ${sent} ${to} for ${order} (${reason}).`,
    ...(e.livemode ? [] : ['This is a test refund: no real money moved.']),
    ...(r.externalRef ? [`Your refund reference: ${oneLine(r.externalRef)}`] : []),
    ...(fee.gt(0) ? [`Network fee: ${amountText(fee, asset, r.assetId)}`] : []),
    '',
    r.refundTxHash
      ? `Transaction: ${txUrl || `${r.refundTxHash} on NEAR`}`
      : 'Transaction: not available',
    `See the payment: ${dashboardUrl}`,
  ].join('\n');

  await sendOncePerEvent(e.id, 'refund_sent', target.recipients, {
    subject,
    text,
    data: {
      store_name: target.name,
      livemode: String(e.livemode),
      refund_id: r.id,
      payment_id: payment.id,
      external_ref: payment.session.externalRef ?? '',
      refund_external_ref: r.externalRef ?? '',
      reason: r.reason,
      amount_to_customer: asset ? decimalAmount(toCustomer, asset.decimals) : toCustomer.toFixed(0),
      network_fee: asset ? decimalAmount(fee, asset.decimals) : fee.toFixed(0),
      symbol: asset?.symbol ?? r.assetId,
      tx_hash: r.refundTxHash ?? '',
      tx_url: txUrl,
      dashboard_url: dashboardUrl,
    },
  });
}

const HANDLERS = [
  ['payment.succeeded', 'notify-payment-received', (e: Event) => onPaymentReceivedNotice(e)],
  ['refund.sent', 'notify-refund-sent', (e: Event) => onRefundSentNotice(e)],
] as const;

/** Registers the store payment and refund emails (once). */
export function registerPaymentNotices(): void {
  for (const [type, name, fn] of HANDLERS) {
    if (!handlerNamesFor(type).includes(name)) registerEventHandler(type, name, fn);
  }
}
