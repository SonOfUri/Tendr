import { randomBytes } from 'node:crypto';
import type { WebhookEventType } from '@tendr/contracts';
import type { Prisma } from '@prisma/client';
import { env } from '../env.js';
import { generateWebhookSecret, signPayload } from '../lib/crypto.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

export async function enqueueWebhook(
  merchantId: string,
  eventType: WebhookEventType,
  data: Record<string, unknown>,
) {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { merchantId, enabled: true, deletedAt: null },
  });
  if (endpoints.length === 0) return;

  const eventId = `evt_${randomBytes(12).toString('hex')}`;
  const payload = {
    id: eventId,
    type: eventType,
    createdAt: new Date().toISOString(),
    data,
  } as Prisma.InputJsonValue;

  for (const endpoint of endpoints) {
    await prisma.webhookDelivery.create({
      data: {
        endpointId: endpoint.id,
        eventId,
        eventType,
        payload,
        status: 'pending',
        attempts: 0,
        nextRetryAt: new Date(),
      },
    });
  }

  // In-process delivery for scaffold (Redis queue optional later).
  void processPendingDeliveries();
}

export async function processPendingDeliveries() {
  const pending = await prisma.webhookDelivery.findMany({
    where: {
      status: { in: ['pending', 'retrying'] },
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }],
    },
    include: { endpoint: true },
    take: 20,
  });

  for (const delivery of pending) {
    const body = JSON.stringify(delivery.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    // Scaffold: endpoints store hash only; use env signing secret for demo deliveries.
    // Production would recover/use per-endpoint raw secret from a vault at creation time.
    const signature = signPayload(body, env().WEBHOOK_SIGNING_SECRET, timestamp);
    try {
      const res = await fetch(delivery.endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Tendr-Signature': signature,
          'Tendr-Timestamp': String(timestamp),
          'Tendr-Event-Id': delivery.eventId,
          'Tendr-Event-Type': delivery.eventType,
        },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status: 'delivered',
            attempts: delivery.attempts + 1,
            deliveredAt: new Date(),
            lastError: null,
          },
        });
      } else {
        await scheduleRetry(delivery.id, delivery.attempts + 1, `HTTP ${res.status}`);
      }
    } catch (err) {
      await scheduleRetry(delivery.id, delivery.attempts + 1, String(err));
    }
  }
}

async function scheduleRetry(id: string, attempts: number, error: string) {
  const maxAttempts = 5;
  if (attempts >= maxAttempts) {
    await prisma.webhookDelivery.update({
      where: { id },
      data: { status: 'failed', attempts, lastError: error },
    });
    log('warn', 'webhook delivery failed permanently', { id, error });
    return;
  }
  const jitter = Math.floor(Math.random() * 1000);
  const delayMs = Math.min(60_000, 2 ** attempts * 500) + jitter;
  await prisma.webhookDelivery.update({
    where: { id },
    data: {
      status: 'retrying',
      attempts,
      lastError: error,
      nextRetryAt: new Date(Date.now() + delayMs),
    },
  });
}

export { generateWebhookSecret };
