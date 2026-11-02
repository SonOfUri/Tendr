import { localMailRequestAllowed } from '@/lib/local-mail-policy';
import { readLocalMail } from '@/lib/local-mail.server';

export const dynamic = 'force-dynamic';
const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex',
  'Referrer-Policy': 'no-referrer',
};

export async function GET(request: Request) {
  if (!localMailRequestAllowed(request, process.env))
    return Response.json({ error: 'Not found' }, { status: 404, headers });
  try {
    return Response.json({ messages: await readLocalMail() }, { headers });
  } catch {
    return Response.json(
      { error: 'Could not read the local inbox. Try again.' },
      { status: 500, headers },
    );
  }
}
