import { NextResponse } from 'next/server';
import { getServerTendrClient } from '@/lib/tendr-server';

export async function GET(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  try {
    const { sessionId } = await context.params;
    const client = getServerTendrClient();
    const session = await client.getCheckoutSession(sessionId);
    let quote = null;
    if (['CREATED', 'AWAITING_PAYMENT'].includes(session.status)) {
      quote = await client.createQuote(sessionId, {
        sourceAsset: 'USDC',
        sourceNetwork: 'near',
      });
    }
    return NextResponse.json({ session, quote });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load session';
    return NextResponse.json({ error: { message } }, { status: 404 });
  }
}
