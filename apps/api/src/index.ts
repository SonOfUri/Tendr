import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { loadEnv, env } from './env.js';
import { loadDotenvFile } from './lib/load-dotenv.js';
import { log } from './lib/logger.js';
import { prisma } from './lib/prisma.js';

// Load monorepo root .env (apps/api cwd) — does not override existing env.
loadDotenvFile(resolve(process.cwd(), '../../.env'));
loadDotenvFile(resolve(process.cwd(), '.env'));

async function main() {
  loadEnv();
  const app = await buildApp();
  const port = env().API_PORT;

  const shutdown = async (signal: string) => {
    log('info', 'shutting down', { signal });
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  const host = process.env.API_HOST ?? '127.0.0.1';
  await app.listen({ port, host });
  log('info', 'Tendr API listening', { port });
}

main().catch((err) => {
   
  console.error(err);
  process.exit(1);
});
