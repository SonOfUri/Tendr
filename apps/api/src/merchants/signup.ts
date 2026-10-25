// Store creation at signup: the person (already verified, with a passkey) names their store; the
// store gets a slug and the person becomes its owner and first signer.
//
// The slug becomes the NEAR account label (`<slug>.tendr.near` / `<slug>.tendr.testnet`), so it is
// lower-case `[a-z0-9-]`, 3–32 characters, with no leading, trailing or doubled `-`.
import { Prisma, type Merchant, type MerchantAccount, type MerchantUser } from '@prisma/client';
import { createTestAccount } from '../accounts/accounts.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { conflict } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { prisma } from '../lib/prisma.js';

/** Longest base slug; leaves room for a `-NNN` collision suffix within 32 characters. */
const MAX_BASE = 28;
const MAX_SLUG = 32;
const ATTEMPTS = 10;
/** Most stores one person may own: each store costs a funded testnet account. */
export const MAX_OWNED_STORES = 5;

/** The slug a store name maps to before collision suffixes. */
export function slugBase(name: string): string {
  let s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  s = s.slice(0, MAX_BASE).replace(/-+$/, '');
  if (s.length === 0) return 'store';
  return s.length < 3 ? `${s}-store` : s;
}

/** The next free slug for `base`: `base`, then `base-2`, `base-3`, … */
async function nextSlug(base: string): Promise<string> {
  const taken = await prisma.merchant.findMany({
    where: { OR: [{ slug: base }, { slug: { startsWith: `${base}-` } }] },
    select: { slug: true },
  });
  const used = new Set(taken.map((t) => t.slug));
  if (!used.has(base)) return base;
  let n = 2;
  for (const { slug } of taken) {
    const m = new RegExp(`^${base}-(\\d+)$`).exec(slug);
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  const slug = `${base}-${n}`;
  if (slug.length > MAX_SLUG) throw conflict('No free slug for this store name; choose another');
  return slug;
}

const isSlugConflict = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError &&
  err.code === 'P2002' &&
  JSON.stringify(err.meta ?? {}).includes('slug');

/**
 * Creates a store owned by `userId`. The person must hold at least one active passkey: an owner
 * is a signer, and a signer without a key could never approve anything. A person owns at most
 * `MAX_OWNED_STORES` stores. The store's test account row is created `provisioning` and its
 * provisioning queued (a job; see accounts/accounts.ts) in the same transaction.
 */
export async function createStore(
  userId: string,
  name: string,
): Promise<{ merchant: Merchant; membership: MerchantUser; testAccount: MerchantAccount }> {
  const passkeys = await prisma.webauthnCredential.count({ where: { userId, revokedAt: null } });
  if (passkeys === 0) throw conflict('Register a passkey before creating a store');

  const base = slugBase(name);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const slug = await nextSlug(base);
    const merchantId = newId('mer');
    try {
      return await tenantTransaction({ merchantId, livemode: false }, async (tx, ctx) => {
        // Serialise this person's store creations so concurrent requests cannot pass the cap.
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
        const owned = await tx.merchantUser.count({ where: { userId, role: 'owner' } });
        if (owned >= MAX_OWNED_STORES) {
          throw conflict(`A person can own at most ${MAX_OWNED_STORES} stores`);
        }
        const merchant = await tx.merchant.create({ data: { id: ctx.merchantId, name, slug } });
        const membership = await tx.merchantUser.create({
          data: {
            id: newId('usr'),
            merchantId: ctx.merchantId,
            userId,
            role: 'owner',
            isSigner: true,
          },
        });
        const testAccount = await createTestAccount(tx, ctx, slug);
        return { merchant, membership, testAccount };
      });
    } catch (err) {
      // Another store took the slug between the lookup and the insert: pick the next one.
      if (!isSlugConflict(err)) throw err;
    }
  }
  throw conflict('Could not reserve a slug for this store; try again');
}
