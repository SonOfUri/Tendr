import type { Event } from '@prisma/client';
import type { JobsOptions } from 'bullmq';

export type EventHandler = (event: Event) => Promise<void>;

/** Joins event id and handler name into a BullMQ job id (BullMQ rejects most ids containing ':'). */
export const JOB_ID_SEPARATOR = '__';

const registry = new Map<string, Map<string, EventHandler>>();
/** Per-handler retry overrides, merged over the default event-job options. */
const jobOptions = new Map<string, JobsOptions>();
const optionsKey = (eventType: string, name: string) => `${eventType}${JOB_ID_SEPARATOR}${name}`;

/**
 * Subscribes `fn` to events of `eventType`. `name` identifies the handler in job ids and the
 * failed set, so it must be unique per event type and stable across deploys. Handlers run
 * at least once per event and must be idempotent on `event.id`.
 */
export function registerEventHandler(
  eventType: string,
  name: string,
  fn: EventHandler,
  /** Overrides of the default retry policy for this handler's jobs (e.g. more attempts). */
  options?: Pick<JobsOptions, 'attempts' | 'backoff'>,
): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes(JOB_ID_SEPARATOR)) {
    throw new Error(
      `invalid handler name ${JSON.stringify(name)}: use letters, digits, '.', '-' or '_' (not '${JOB_ID_SEPARATOR}')`,
    );
  }
  const byName = registry.get(eventType) ?? new Map<string, EventHandler>();
  if (byName.has(name)) {
    throw new Error(`handler ${name} is already registered for ${eventType}`);
  }
  byName.set(name, fn);
  registry.set(eventType, byName);
  if (options) jobOptions.set(optionsKey(eventType, name), options);
}

/** The handler's own job-option overrides (empty when it uses the defaults). */
export function handlerJobOptions(eventType: string, name: string): JobsOptions {
  return jobOptions.get(optionsKey(eventType, name)) ?? {};
}

/** Names of the handlers subscribed to `eventType`. */
export function handlerNamesFor(eventType: string): string[] {
  return [...(registry.get(eventType)?.keys() ?? [])];
}

/** Event types with at least one registered handler — the only outbox rows the dispatcher claims. */
export function handledEventTypes(): string[] {
  return [...registry.keys()];
}

export function getEventHandler(eventType: string, name: string): EventHandler | undefined {
  return registry.get(eventType)?.get(name);
}

/** Test-only: forgets every registered handler. */
export function clearEventHandlers(): void {
  registry.clear();
  jobOptions.clear();
}
