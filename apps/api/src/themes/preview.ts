// Theme preview links (spec §10): a merchant opens its DRAFT as a shopper would see it, on a link
// that anyone holding it can open for 15 minutes.
// - `createPreviewToken` stores `theme-preview:<sha256(token)>` in Redis for 900 s; the token
//   (32 random bytes, base64url) is the only secret and maps to a merchant and theme, nothing else.
// - `readPreview` loads the CURRENT draft through the merchant's test-mode scoped client, so edits
//   show up on refresh. It never creates a session: the amount and cart are fixed samples.
import { randomBytes } from 'node:crypto';
import { ThemePreviewSchema, type ShopperTheme, type ThemePreview } from '@tendr/contracts';
import { z } from 'zod';
import { scopedDb } from '../db/scoped.js';
import { env } from '../env.js';
import { sha256 } from '../lib/crypto.js';
import { notFound } from '../lib/errors.js';
import { getRedis } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import { resolveShopperTheme } from './resolve.js';
import type { ThemeCtx } from './themes.js';

/** A preview link works for 15 minutes. */
export const PREVIEW_TTL_S = 900;

const key = (token: string) => `theme-preview:${sha256(token)}`;

const StoredSchema = z.object({
  merchantId: z.string(),
  themeId: z.string(),
  draftVersionHash: z.string(),
  opts: ThemePreviewSchema,
});

export type PreviewSample = {
  kind: 'checkout' | 'link';
  amount: string;
  amount_currency: 'NGN' | 'USD';
  line_items: {
    name: string;
    quantity: number;
    unit_amount: string;
    description: string | null;
    image_url: string | null;
  }[];
  link?: { title: string; description: string };
};

export type PreviewRead = {
  preview: true;
  opts: ThemePreview;
  theme: ShopperTheme;
  sample: PreviewSample;
};

/** Mints a preview link for the merchant's draft of `themeId`; 404 if the theme is not theirs. */
export async function createPreviewToken(
  ctx: ThemeCtx,
  themeId: string,
  opts: ThemePreview,
): Promise<{ url: string; expires_at: string }> {
  const theme = await ctx.db.checkoutTheme.findFirst({
    where: { id: themeId },
    select: { draft: true, draftCss: true },
  });
  if (!theme) throw notFound('No theme with that id');
  const token = randomBytes(32).toString('base64url');
  const stored = {
    merchantId: ctx.merchantId,
    themeId,
    draftVersionHash: sha256(JSON.stringify([theme.draft, theme.draftCss])),
    opts,
  };
  await getRedis().set(key(token), JSON.stringify(stored), 'EX', PREVIEW_TTL_S);
  return {
    url: `${env().CHECKOUT_BASE_URL.replace(/\/+$/, '')}/preview/theme/${token}`,
    expires_at: new Date(Date.now() + PREVIEW_TTL_S * 1000).toISOString(),
  };
}

/** NGN when the merchant's latest session (either mode) was in NGN, else USD. */
async function sampleCurrency(merchantId: string): Promise<'NGN' | 'USD'> {
  const latest = await Promise.all(
    [true, false].map((livemode) =>
      scopedDb({ merchantId, livemode }).session.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, amountCurrency: true, originalCurrency: true },
      }),
    ),
  );
  const newest = latest
    .filter((s) => s !== null)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return (newest?.originalCurrency ?? newest?.amountCurrency) === 'NGN' ? 'NGN' : 'USD';
}

function sampleOf(
  kind: 'checkout' | 'link',
  currency: 'NGN' | 'USD',
  link: { title: string; description: string },
): PreviewSample {
  const base = `${env().CHECKOUT_BASE_URL.replace(/\/+$/, '')}/preview`;
  const ngn = currency === 'NGN';
  return {
    kind,
    amount: ngn ? '25000' : '49.00',
    amount_currency: currency,
    line_items: [
      {
        name: 'Linen shirt',
        quantity: 1,
        unit_amount: ngn ? '15000' : '29.00',
        description: 'Sample item',
        image_url: `${base}/sample-shirt.webp`,
      },
      {
        name: 'Canvas tote',
        quantity: 1,
        unit_amount: ngn ? '10000' : '20.00',
        description: 'Sample item',
        image_url: `${base}/sample-tote.webp`,
      },
    ],
    ...(kind === 'link' ? { link } : {}),
  };
}

/** What the preview page shows; 404 for an unknown or expired token, or a deleted theme. */
export async function readPreview(token: string): Promise<PreviewRead> {
  const raw = token.length >= 16 && token.length <= 128 ? await getRedis().get(key(token)) : null;
  if (!raw) throw notFound('This preview link is unknown or has expired');
  let stored: z.infer<typeof StoredSchema>;
  try {
    stored = StoredSchema.parse(JSON.parse(raw));
  } catch {
    throw notFound('This preview link is unknown or has expired');
  }
  const merchant = await prisma.merchant.findUnique({
    where: { id: stored.merchantId },
    select: { id: true, name: true, status: true },
  });
  if (!merchant || merchant.status !== 'active') throw notFound('Preview not available');
  const db = scopedDb({ merchantId: merchant.id, livemode: false });
  if (!(await db.checkoutTheme.findFirst({ where: { id: stored.themeId }, select: { id: true } }))) {
    throw notFound('This theme no longer exists');
  }
  const link = { title: 'Sample payment link', description: 'Your link page, as shoppers see it.' };
  const theme = await resolveShopperTheme(db, {
    merchantId: merchant.id,
    merchantName: merchant.name,
    themeId: stored.themeId,
    livemode: false,
    kind: stored.opts.sample,
    ...(stored.opts.sample === 'link' ? { link } : {}),
  });
  return {
    preview: true,
    opts: stored.opts,
    theme,
    sample: sampleOf(stored.opts.sample, await sampleCurrency(merchant.id), link),
  };
}
