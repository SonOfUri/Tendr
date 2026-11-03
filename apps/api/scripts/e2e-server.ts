// The API and the worker in ONE process, for the dashboard's end-to-end tests (and offline
// demos). With NEAR_CLIENT_DRIVER=fake each process has its own in-memory NEAR; sharing one
// process lets the worker provision an account that the API then relays proposals to, with
// NEAR_FAKE_SIMULATE=1 running the merchant-account contract in memory.
//
// Refuses to start in production or with a non-fake NEAR driver. Env comes from the caller (the
// Playwright config sets the test database, a separate Redis DB, MAIL_DRIVER=log), then the root
// .env for anything unset.
import { resolve } from 'node:path';
import { buildApp } from '../src/app.js';
import { env, loadEnv } from '../src/env.js';
import { loadDotenvFile } from '../src/lib/load-dotenv.js';
import { log } from '../src/lib/logger.js';
import { prisma } from '../src/lib/prisma.js';
import { startWorker } from '../src/worker.js';
import { restoreLocalConsoleState } from './local-console-state.js';

async function main() {
  loadDotenvFile(resolve(process.cwd(), '../../.env'));
  loadDotenvFile(resolve(process.cwd(), '.env'));
  loadEnv();
  const e = env();
  if (e.NODE_ENV === 'production' || e.NEAR_CLIENT_DRIVER !== 'fake') {
    throw new Error('e2e-server runs only with NEAR_CLIENT_DRIVER=fake outside production');
  }
  if (process.env.API_CONSOLE_STATE_PATH) {
    const restored = await restoreLocalConsoleState(process.env.API_CONSOLE_STATE_PATH);
    console.log('Local simulator ready', restored);
  }
  const app = await buildApp();
  const worker = await startWorker({ healthPort: 0, dispatchIntervalMs: 250 });
  await app.listen({ port: e.API_PORT, host: e.API_HOST });
  log('info', 'Tendr e2e server listening', { port: e.API_PORT });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    await worker.stop();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
