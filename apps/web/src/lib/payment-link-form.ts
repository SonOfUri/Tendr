// Dashboard helpers for one payment link: display words and the edit form's PATCH body. The body
// only carries what changed, because the API's update schema ties some keys together (a fixed
// `amount_type` needs an `amount`, an open one refuses it, a currency change needs a new amount).
import type { PaymentLinkView } from './payment-link-types';

export type LinkForm = {
  title: string;
  description: string;
  amountType: 'fixed' | 'open';
  currency: string;
  amount: string;
  minAmount: string;
  note: 'off' | 'optional';
  status: 'active' | 'inactive';
  /** `datetime-local` value (local time), '' for no expiry. */
  expiresAt: string;
  maxUses: string;
  /** '' = the store's default. */
  feePayer: '' | 'merchant' | 'shopper';
  gasPayer: '' | 'merchant' | 'shopper';
  gasMaxUsd: string;
  /** '' = the store's default theme. */
  themeId: string;
  /** Null = the store's settlement token. */
  settlementAsset: string | null;
};

const pad = (n: number) => String(n).padStart(2, '0');

/** An ISO instant as a `datetime-local` value in the browser's time zone. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formFromLink(link: PaymentLinkView): LinkForm {
  return {
    title: link.title,
    description: link.description ?? '',
    amountType: link.amount_type,
    currency: link.currency,
    amount: link.amount ?? '',
    minAmount: link.min_amount ?? '',
    note: link.note,
    status: link.status,
    expiresAt: toLocalInput(link.expires_at),
    maxUses: link.max_uses === null ? '' : String(link.max_uses),
    feePayer: link.fee_payer ?? '',
    gasPayer: link.gas_payer ?? '',
    gasMaxUsd: link.gas_max_usd ?? '',
    themeId: link.theme_id ?? '',
    settlementAsset: link.settlement_asset ?? null,
  };
}

export type PatchResult = { body: Record<string, unknown> } | { error: string };

const DECIMAL = /^\d+(?:\.\d+)?$/;

/** The PATCH body for the edit form, or the message to show. An empty body means no changes. */
export function buildLinkPatch(link: PaymentLinkView, f: LinkForm): PatchResult {
  const body: Record<string, unknown> = {};
  const before = formFromLink(link);

  const title = f.title.trim();
  if (!title) return { error: 'Title is required' };
  if (title !== before.title) body.title = title;

  const description = f.description.trim();
  if (description !== before.description.trim()) body.description = description || null;

  const currency = f.currency.trim().toUpperCase();
  if (!currency) return { error: 'Currency is required' };
  const typeChanged = f.amountType !== before.amountType;
  const currencyChanged = currency !== before.currency;
  if (typeChanged) body.amount_type = f.amountType;
  if (currencyChanged) body.currency = currency;

  if (f.amountType === 'fixed') {
    const amount = f.amount.trim();
    if (!amount) return { error: 'Amount is required for a fixed link' };
    if (!DECIMAL.test(amount)) return { error: 'Amount must be a decimal like 25.00' };
    if (typeChanged || currencyChanged || amount !== before.amount.trim()) body.amount = amount;
  } else {
    const min = f.minAmount.trim();
    if (min && !DECIMAL.test(min)) return { error: 'Minimum must be a decimal like 5.00' };
    // A type or currency change clears the stored minimum on the API, so only resend what is set.
    if (typeChanged || currencyChanged) {
      if (min) body.min_amount = min;
    } else if (min !== before.minAmount.trim()) {
      body.min_amount = min || null;
    }
  }

  if (f.note !== before.note) body.note = f.note;
  if (f.status !== before.status) body.status = f.status;

  if (f.expiresAt !== before.expiresAt) {
    if (f.expiresAt) {
      const when = new Date(f.expiresAt);
      if (Number.isNaN(when.getTime())) return { error: 'Expiry is not a valid date' };
      if (when.getTime() <= Date.now()) return { error: 'Expiry must be in the future' };
      body.expires_at = when.toISOString();
    } else {
      body.expires_at = null;
    }
  }

  if (f.maxUses.trim() !== before.maxUses) {
    const raw = f.maxUses.trim();
    if (!raw) body.max_uses = null;
    else {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) return { error: 'Max uses must be a whole number of 1 or more' };
      body.max_uses = n;
    }
  }

  if (f.feePayer !== before.feePayer) body.fee_payer = f.feePayer || null;
  if (f.gasPayer !== before.gasPayer) body.gas_payer = f.gasPayer || null;

  if (f.gasMaxUsd.trim() !== before.gasMaxUsd) {
    const raw = f.gasMaxUsd.trim();
    if (raw && !DECIMAL.test(raw)) return { error: 'Gas cap must be a decimal like 0.50' };
    body.gas_max_usd = raw || null;
  }

  if (f.themeId !== before.themeId) body.theme_id = f.themeId || null;

  if ((f.settlementAsset ?? null) !== (before.settlementAsset ?? null)) {
    body.settlement_asset = f.settlementAsset;
  }

  return { body };
}

/** Amount as shown in a list or header: `25.00 USD`, or `Open · min 5.00 USD`. */
export function linkAmountLabel(
  link: Pick<PaymentLinkView, 'amount_type' | 'amount' | 'currency' | 'min_amount'>,
): string {
  if (link.amount_type === 'fixed') return `${link.amount ?? '—'} ${link.currency}`;
  return link.min_amount
    ? `Open · min ${link.min_amount} ${link.currency}`
    : `Open · ${link.currency}`;
}

export function linkUsesLabel(link: Pick<PaymentLinkView, 'use_count' | 'max_uses'>): string {
  if (link.max_uses !== null) return `${link.use_count} / ${link.max_uses}`;
  return `${link.use_count} use${link.use_count === 1 ? '' : 's'}`;
}

/** What each availability means to the merchant (the payer sees most of these as "unavailable"). */
export const AVAILABILITY_WORDS: Readonly<Record<string, string>> = {
  available: 'Taking payments',
  inactive: 'Switched off',
  archived: 'Archived',
  expired: 'Expired',
  used_up: 'Used up',
  merchant_not_ready: 'Business not ready for payments',
};

export const availabilityWords = (a: string): string => AVAILABILITY_WORDS[a] ?? a;
