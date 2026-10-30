// Runs once when a Next.js server starts: a production server without the config it needs (the
// payment links' WEB_INTERNAL_TOKEN) fails at boot instead of on its first request.
import { assertServerEnv } from './lib/env';

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  assertServerEnv();
}
