// Prints jobs in BullMQ's failed set (dead letters): id, handler, attempts, last error.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/env.js';
import {
  closeConnection,
  createEventsQueue,
  createMaintenanceQueue,
  createQueueConnection,
  listFailedJobs,
} from '../src/jobs/queue.js';
import { loadDotenvFile } from '../src/lib/load-dotenv.js';

loadDotenvFile(resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../.env'));
loadEnv();

const connection = createQueueConnection();
const queues = [createEventsQueue({ connection }), createMaintenanceQueue({ connection })];
try {
  for (const queue of queues) {
    const failed = await listFailedJobs(queue);
    console.log(`${queue.name}: ${failed.length} failed`);
    for (const j of failed) {
      console.log(`  ${j.id}  handler=${j.handler}  attempts=${j.attempts}  error=${j.error}`);
    }
  }
} finally {
  await Promise.all(queues.map((q) => q.close()));
  await closeConnection(connection);
}
