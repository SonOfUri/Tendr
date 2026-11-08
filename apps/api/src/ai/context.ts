import { readOnlyDb, type ScopeContext } from '../db/scoped.js';
import { notFound } from '../lib/errors.js';

export type AiContext = ScopeContext & { sessionId: string };

/** Every lookup is tenant + mode scoped. Neither the model nor callers supply a database client. */
export async function aiSession(ctx: AiContext) {
  const db = readOnlyDb(ctx);
  const session = await db.session.findFirst({
    where: { id: ctx.sessionId },
    select: {
      id: true,
      status: true,
      amount: true,
      amountCurrency: true,
      expiresAt: true,
      feePayer: true,
      gasSponsor: true,
      feeBps: true,
      destAsset: true,
      recipient: true,
      recipientType: true,
      intentsAccount: true,
    },
  });
  if (!session) throw notFound('Session not found');
  return { db, session };
}
