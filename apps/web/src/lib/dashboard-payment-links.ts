import {
  PaymentLinkCreateSchema,
  PaymentLinkUpdateSchema,
  type PaymentLinkAvailability,
} from '@tendr/contracts';

/** Fields used by the dashboard from the merchant payment-link response. */
export interface DashboardPaymentLink {
  id: string;
  title: string;
  description: string | null;
  slug: string;
  url: string;
  qr_url: string;
  livemode: boolean;
  amount_type: 'fixed' | 'open';
  amount: string | null;
  min_amount: string | null;
  currency: string;
  note: 'off' | 'optional';
  status: 'active' | 'inactive';
  archived: boolean;
  availability: PaymentLinkAvailability;
  expires_at: string | null;
  max_uses: number | null;
  use_count: number;
}

export interface PaymentLinkList {
  data: DashboardPaymentLink[];
  has_more: boolean;
}

export const AVAILABILITY: Record<PaymentLinkAvailability, string> = {
  available: 'Ready to accept payments',
  inactive: 'Paused',
  archived: 'Archived',
  expired: 'Expired',
  used_up: 'Usage limit reached',
  merchant_not_ready: 'Store setup needed',
};

export interface LinkFields {
  title: string;
  description: string;
  slug: string;
  amountType: 'fixed' | 'open';
  amount: string;
  minimum: string;
  currency: string;
  note: 'off' | 'optional';
  status: 'active' | 'inactive';
  expires: string;
  maxUses: string;
}

function localDateTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function linkFields(link?: DashboardPaymentLink): LinkFields {
  return {
    title: link?.title ?? '',
    description: link?.description ?? '',
    slug: link?.slug ?? '',
    amountType: link?.amount_type ?? 'fixed',
    amount: link?.amount ?? '',
    minimum: link?.min_amount ?? '',
    currency: link?.currency ?? 'USD',
    note: link?.note ?? 'optional',
    status: link?.status ?? 'active',
    expires: localDateTime(link?.expires_at ?? null),
    maxUses: link?.max_uses?.toString() ?? '',
  };
}

/** Keep monetary values as decimal strings; null clears optional fields when editing. */
export function linkBody(fields: LinkFields, existing?: DashboardPaymentLink) {
  const max = fields.maxUses ? Number(fields.maxUses) : null;
  if (max !== null && (!Number.isSafeInteger(max) || max < 1)) {
    throw new Error('Maximum payments must be a positive whole number.');
  }
  const expires = fields.expires ? new Date(fields.expires) : null;
  if (expires && !Number.isFinite(expires.getTime())) throw new Error('Enter a valid expiry date.');
  const body = {
    title: fields.title.trim(),
    description: fields.description.trim() || (existing ? null : undefined),
    ...(!existing && fields.slug.trim() ? { slug: fields.slug.trim() } : {}),
    amount_type: fields.amountType,
    ...(fields.amountType === 'fixed'
      ? { amount: fields.amount.trim() }
      : { min_amount: fields.minimum.trim() || (existing ? null : undefined) }),
    currency: fields.currency.trim().toUpperCase(),
    note: fields.note,
    status: fields.status,
    // Don't resubmit an unchanged expiry: an expired link can still have its title edited.
    ...(existing && fields.expires === localDateTime(existing.expires_at)
      ? {}
      : { expires_at: expires?.toISOString() ?? (existing ? null : undefined) }),
    max_uses: max ?? (existing ? null : undefined),
  };
  const parsed = (existing ? PaymentLinkUpdateSchema : PaymentLinkCreateSchema).safeParse(body);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  return parsed.data;
}
