import type { Invoice, NativePayout, Prisma } from '@prisma/client';
import { z } from 'zod';
import { EmailSchema, newLinkToken } from '../auth/magic-link.js';
import { getMailer } from '../auth/mailer.js';
import { ownedNativeWallet, type NativeActor } from '../accounts/native-accounts.js';
import { chainFamily, isValidAddress } from '../checkout/address-format.js';
import { tokenInfo, tokenList } from '../checkout/tokens.js';
import type { ScopeContext } from '../db/scoped.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { env } from '../env.js';
import { recordEvent } from '../events/record.js';
import { sha256 } from '../lib/crypto.js';
import { AppError, conflict, notFound, unauthorized } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { assertLiveModeOpen } from '../lib/live-mode.js';
import { prisma } from '../lib/prisma.js';
import { getRedis } from '../lib/redis.js';

const scope = (ctx: ScopeContext) => ({ merchantId: ctx.merchantId, livemode: ctx.livemode });
const text = (max: number) => z.string().trim().min(1).max(max);
export const InvoiceInput = z
  .object({
    contractorName: text(120),
    email: EmailSchema,
    reference: text(80),
    description: text(2000),
    dueDate: z.string().date().optional(),
    destinationAsset: z.string().min(8).max(256).startsWith('nep141:'),
    destination: text(128),
    // Decimal token units, never floating point or a fiat conversion.
    amount: z.string().regex(/^(?:0|[1-9]\d{0,38})(?:\.\d{1,30})?$/),
  })
  .strict();
export const InvoiceTokenInput = z
  .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();

export function invoiceUnits(value: string, decimals: number): string {
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals)
    throw new AppError('VALIDATION_ERROR', 'Too many decimal places for this token', 400);
  const units = BigInt(`${whole}${fraction.padEnd(decimals, '0')}`);
  if (units <= 0n || units >= 1n << 128n)
    throw new AppError('VALIDATION_ERROR', 'Invoice amount is out of range', 400);
  return units.toString();
}

export function invoiceUrl(slug: string): string {
  return `${env().INVOICE_BASE_URL.replace(/\/$/, '')}/${encodeURIComponent(slug)}`;
}

async function publicBusiness(slug: string) {
  assertLiveModeOpen();
  const merchant = await prisma.merchant.findFirst({
    where: {
      slug,
      status: 'active',
      invoicesEnabled: true,
      nativeWallets: {
        some: { livemode: true, account: { status: 'active', kind: 'native_intents' } },
      },
    },
    select: { id: true, name: true, slug: true },
  });
  if (!merchant) throw notFound('This business is not accepting invoices');
  return merchant;
}

export async function publicInvoiceBusiness(slug: string) {
  const business = await publicBusiness(slug);
  const tokens = [...(await tokenList(true)).values()]
    // Only routes whose external destination validator is implemented; memo/tag routes excluded.
    .filter((t) => chainFamily(t.blockchain) !== 'other');
  return { business: { name: business.name, slug: business.slug }, tokens };
}

/** Fail closed: one mailbox cannot be spammed by rotating IPs or businesses. */
export async function invoiceMailLimit(email: string, ip: string) {
  for (const [key, limit] of [
    [`email:${sha256(email)}`, 3],
    [`ip:${sha256(ip)}`, 10],
    ['global', 200],
  ] as const) {
    const count = Number(
      await getRedis().eval(
        "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], 3600) end; return n",
        1,
        `tendr:invoice-mail:${key}`,
      ),
    );
    if (count > limit)
      throw new AppError('RATE_LIMITED', 'Too many invoice emails. Try again later.', 429);
  }
}

export async function submitInvoice(slug: string, input: z.infer<typeof InvoiceInput>, ip: string) {
  const business = await publicBusiness(slug);
  await invoiceMailLimit(input.email, ip);
  const token = await tokenInfo(true, input.destinationAsset);
  if (
    chainFamily(token.blockchain) === 'other' ||
    !isValidAddress(token.blockchain, input.destination)
  )
    throw new AppError(
      'VALIDATION_ERROR',
      'Choose a supported receiving chain and valid external wallet address. Memo/tag destinations are not supported.',
      400,
    );
  const amount = invoiceUnits(input.amount, token.decimals);
  const ctx = { merchantId: business.id, livemode: true };
  const { raw, hash } = newLinkToken();
  const row = await tenantTransaction(ctx, async (tx) => {
    // References are unique per contractor and business. Concurrent retries cannot create bills twice.
    await tx.$queryRaw`SELECT id FROM merchants WHERE id = ${business.id} FOR UPDATE`;
    const existing = await tx.invoice.findFirst({
      where: { ...ctx, email: input.email, reference: input.reference },
    });
    if (existing && existing.status !== 'awaiting_verification') return null;
    // The original draft wins. A resend rotates its private link but never changes its terms.
    const data = { accessTokenHash: hash, verifyExpiresAt: new Date(Date.now() + 24 * 3600_000) };
    if (existing) return tx.invoice.update({ where: { id: existing.id, ...ctx }, data });
    return tx.invoice.create({
      data: {
        id: newId('bill'),
        ...ctx,
        ...input,
        amount,
        destinationChain: token.blockchain,
        symbol: token.symbol,
        decimals: token.decimals,
        ...data,
      },
    });
  });
  if (row) {
    const url = `${invoiceUrl(business.slug)}#token=${raw}`;
    await getMailer().send({
      to: input.email,
      template: 'invoice_verify',
      data: { business: business.name, url },
    });
  }
  // No invoice id, token, email existence, or invoice status is disclosed to an unverified caller.
  return { accepted: true };
}

type WithPayouts = Invoice & { payouts: NativePayout[] };
export function invoiceView(row: WithPayouts) {
  const p = row.payouts[0];
  return {
    id: row.id,
    contractorName: row.contractorName,
    email: row.email,
    reference: row.reference,
    description: row.description,
    dueDate: row.dueDate,
    destination: row.destination,
    destinationAsset: row.destinationAsset,
    destinationChain: row.destinationChain,
    amount: row.amount,
    symbol: row.symbol,
    decimals: row.decimals,
    status: row.status,
    verifiedAt: row.verifiedAt,
    paidAt: row.paidAt,
    createdAt: row.createdAt,
    payout: p
      ? {
          id: p.id,
          status:
            p.status === 'awaiting_signature' && p.expiresAt <= new Date() ? 'expired' : p.status,
          asset: p.asset,
          amount: p.amount,
          expiresAt: p.expiresAt,
          providerStatus: p.providerStatus,
        }
      : null,
  };
}
const include = { payouts: { orderBy: { createdAt: 'desc' as const }, take: 1 } };

async function tokenInvoice(slug: string, raw: string) {
  const row = await prisma.invoice.findFirst({
    where: { accessTokenHash: sha256(raw), livemode: true, merchant: { slug, status: 'active' } },
    include,
  });
  if (!row) throw unauthorized('Invalid invoice link');
  return row;
}
export async function readPublicInvoice(slug: string, raw: string) {
  return invoiceView(await tokenInvoice(slug, raw));
}
export async function verifyInvoice(slug: string, raw: string) {
  const row = await tokenInvoice(slug, raw);
  if (row.status !== 'awaiting_verification') return invoiceView(row);
  if (row.verifyExpiresAt <= new Date())
    throw conflict(
      'This verification link expired. Submit the same reference again to receive a fresh link.',
    );
  await publicBusiness(slug);
  return tenantTransaction(row, async (tx) => {
    const changed = await tx.invoice.updateMany({
      where: {
        id: row.id,
        ...scope(row),
        status: 'awaiting_verification',
        accessTokenHash: sha256(raw),
        verifyExpiresAt: { gt: new Date() },
      },
      data: { status: 'open', verifiedAt: new Date() },
    });
    if (!changed.count) throw conflict('The invoice link has changed. Open your latest email.');
    await recordEvent(tx, row, {
      aggregateType: 'invoice',
      aggregateId: row.id,
      type: 'invoice.submitted',
      payload: { invoiceId: row.id },
    });
    return invoiceView(
      await tx.invoice.findFirstOrThrow({ where: { id: row.id, ...scope(row) }, include }),
    );
  });
}

export async function invoiceSettings(ctx: ScopeContext) {
  const merchant = await prisma.merchant.findUniqueOrThrow({ where: { id: ctx.merchantId } });
  return { enabled: merchant.invoicesEnabled, url: invoiceUrl(merchant.slug) };
}
export async function setInvoiceSettings(actor: NativeActor, enabled: boolean) {
  await ownedNativeWallet(actor);
  await tenantTransaction(actor, async (tx) => {
    await tx.merchant.update({
      where: { id: actor.merchantId },
      data: { invoicesEnabled: enabled },
    });
    await recordEvent(tx, actor, {
      aggregateType: 'merchant',
      aggregateId: actor.merchantId,
      type: 'invoice.settings_updated',
      payload: { enabled },
    });
  });
  return invoiceSettings(actor);
}
export async function listInvoices(ctx: ScopeContext, cursor?: string) {
  const rows = await prisma.invoice.findMany({
    where: {
      ...scope(ctx),
      status: { not: 'awaiting_verification' },
      ...(cursor ? { id: { lt: cursor } } : {}),
    },
    orderBy: { id: 'desc' },
    take: 51,
    include,
  });
  return {
    invoices: rows.slice(0, 50).map(invoiceView),
    nextCursor: rows.length > 50 ? rows[49]!.id : null,
  };
}
export async function getInvoice(ctx: ScopeContext, id: string) {
  const row = await prisma.invoice.findFirst({ where: { id, ...scope(ctx) }, include });
  if (!row) throw notFound('Invoice not found');
  return invoiceView(row);
}
export async function lockInvoice(tx: Prisma.TransactionClient, ctx: ScopeContext, id: string) {
  await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${id} AND merchant_id = ${ctx.merchantId} AND livemode = ${ctx.livemode} FOR UPDATE`;
  const row = await tx.invoice.findFirst({ where: { id, ...scope(ctx) } });
  if (!row) throw notFound('Invoice not found');
  return row;
}
export async function rejectInvoice(actor: NativeActor, id: string) {
  await ownedNativeWallet(actor);
  await tenantTransaction(actor, async (tx) => {
    const row = await lockInvoice(tx, actor, id);
    if (row.status === 'rejected') return;
    if (row.status !== 'open') throw conflict('Only an unpaid invoice can be rejected');
    await tx.nativePayout.updateMany({
      where: { invoiceId: id, ...scope(actor), status: 'awaiting_signature' },
      data: { status: 'expired' },
    });
    await tx.invoice.updateMany({
      where: { id, ...scope(actor), status: 'open' },
      data: { status: 'rejected' },
    });
    await recordEvent(tx, actor, {
      aggregateType: 'invoice',
      aggregateId: id,
      type: 'invoice.rejected',
      payload: { ownerUserId: actor.userId },
    });
  });
  return getInvoice(actor, id);
}
