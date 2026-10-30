// Corrupts a theme's stored draft for the web end-to-end tests (apps/web/e2e/themes.spec.ts): the
// "invalid stored theme falls back to the Tendr default" case. The API validates every draft it
// saves, so a broken one can only be written straight to the database, as a bad migration or a
// half-saved row would leave it.
//
//   tsx scripts/e2e-theme-corrupt.ts '{"themeId":"thm_…"}'
//
// TEST DATABASE ONLY: DATABASE_URL is replaced by TEST_DATABASE_URL (environment, then the root
// .env), and it refuses to run without one, or in production.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotenvFile } from '../src/lib/load-dotenv.js';

async function main() {
  loadDotenvFile(resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../.env'));
  if (process.env.NODE_ENV === 'production') throw new Error('e2e script refuses production');
  const testDb = process.env.TEST_DATABASE_URL;
  if (!testDb) throw new Error('TEST_DATABASE_URL is not set');
  process.env.DATABASE_URL = testDb;

  const { themeId } = JSON.parse(process.argv[2] ?? '{}') as { themeId?: string };
  if (!themeId) throw new Error('themeId is required');

  const { prisma } = await import('../src/lib/prisma.js');
  await prisma.checkoutTheme.update({
    where: { id: themeId },
    data: { draft: { schema_version: 1, settings: 'half-saved', blocks: [{ type: 'payment' }] } },
  });
  await prisma.$disconnect();
  process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
