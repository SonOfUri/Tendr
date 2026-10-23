/**
 * Background job adapter boundary.
 *
 * Local scaffold uses in-process webhook delivery (see services/webhooks.ts).
 * To enable Redis later:
 * 1. Add Redis to docker-compose
 * 2. Implement RedisQueueAdapter satisfying JobQueue
 * 3. Set QUEUE_DRIVER=redis
 */

export interface JobQueue {
  enqueue(name: string, payload: Record<string, unknown>, opts?: { delayMs?: number }): Promise<void>;
}

export class InProcessQueue implements JobQueue {
  async enqueue(name: string, payload: Record<string, unknown>): Promise<void> {
    // Handlers are invoked directly by callers today; this type documents the seam.
    void name;
    void payload;
  }
}
