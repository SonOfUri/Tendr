import { NextResponse } from 'next/server';
import { getServerTendrClient } from '@/lib/tendr-server';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { sessionId: string; quoteId: string };
    const client = getServerTendrClient();
    const result = await client.confirmCheckout(body.sessionId, body.quoteId);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Confirm failed';
    return NextResponse.json({ error: { message } }, { status: 500 });
  }
}
