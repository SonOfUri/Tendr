import type { Prisma } from '@prisma/client';
import { ScopeSchema, ScopeValues } from '@tendr/contracts';
import { z } from 'zod';
import type { ScopeContext } from '../db/scoped.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { recordEvent } from '../events/record.js';
import { generateApiKey } from '../lib/crypto.js';
import { notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { prisma } from '../lib/prisma.js';

export const ApiKeyCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    scopes: z.array(ScopeSchema).min(1).max(ScopeValues.length),
  })
  .strict();

// Never select hashes or signing secrets for a dashboard response. Connected-site keys are
// managed through Connect so their keys, webhooks and domain are revoked together.
const SELECT = {
  id: true,
  name: true,
  kind: true,
  livemode: true,
  keyPrefix: true,
  scopes: true,
  createdAt: true,
  lastUsedAt: true,
  revokedAt: true,
} satisfies Prisma.ApiKeySelect;
type Key = Prisma.ApiKeyGetPayload<{ select: typeof SELECT }>;
const view = (key: Key) => ({
  id: key.id,
  name: key.name,
  kind: key.kind,
  livemode: key.livemode,
  prefix: key.keyPrefix,
  scopes: key.scopes,
  created_at: key.createdAt.toISOString(),
  last_used_at: key.lastUsedAt?.toISOString() ?? null,
  revoked_at: key.revokedAt?.toISOString() ?? null,
});
const where = (ctx: ScopeContext) => ({ ...ctx, connectionId: null });

export async function listApiKeys(ctx: ScopeContext) {
  return (
    await prisma.apiKey.findMany({
      where: where(ctx),
      select: SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
  ).map(view);
}

export async function issueApiKey(
  ctx: ScopeContext,
  userId: string,
  input: z.infer<typeof ApiKeyCreateSchema>,
) {
  const generated = generateApiKey('secret', ctx.livemode);
  const key = await tenantTransaction(ctx, async (tx) => {
    const key = await tx.apiKey.create({
      data: {
        id: newId('key'),
        ...ctx,
        name: input.name,
        kind: 'secret',
        scopes: [...new Set(input.scopes)],
        keyPrefix: generated.prefix,
        keyHash: generated.hash,
      },
      select: SELECT,
    });
    await recordEvent(tx, ctx, {
      aggregateType: 'api_key',
      aggregateId: key.id,
      type: 'api_key.created',
      payload: { user_id: userId, name: key.name, prefix: key.keyPrefix, scopes: key.scopes },
    });
    return key;
  });
  // The raw key exists only in this response, never in the database or audit event.
  return { api_key: view(key), secret: generated.raw };
}

export async function revokeApiKey(ctx: ScopeContext, userId: string, id: string) {
  return tenantTransaction(ctx, async (tx) => {
    const changed = await tx.apiKey.updateMany({
      where: { ...where(ctx), id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const key = await tx.apiKey.findFirst({ where: { ...where(ctx), id }, select: SELECT });
    if (!key) throw notFound('API key not found');
    if (changed.count)
      await recordEvent(tx, ctx, {
        aggregateType: 'api_key',
        aggregateId: id,
        type: 'api_key.revoked',
        payload: { user_id: userId, name: key.name, prefix: key.keyPrefix },
      });
    return { api_key: view(key) };
  });
}
