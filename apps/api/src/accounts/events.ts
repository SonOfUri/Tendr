// NEP-297 events of the merchant-account contract (onchain/merchant-account/src/events.rs):
// `EVENT_JSON:{"standard":"tendr-merchant-account","version":"1.0.0","event":…,"data":{…}}`.
// `data` is a single JSON object (not the NEP-297 array form).
//
// This is the one parser for them: the relay (proposals.ts) applies the events in its own
// transaction logs right away, and the chain watcher (Task 12) reuses it for everything else.

export const EVENT_STANDARD = 'tendr-merchant-account';
const PREFIX = 'EVENT_JSON:';

/** Event names the contract emits (`Event` variants in snake_case). */
export const AccountEventNames = [
  'proposal_created',
  'proposal_approved',
  'proposal_cancelled',
  'proposal_executed',
  'proposal_failed',
  'timelock_started',
  'signers_changed',
  'recovery_started',
  'recovery_cancelled',
  'recovery_executed',
  'sweep_executed',
  'settlement_changed',
] as const;
export type AccountEventName = (typeof AccountEventNames)[number];

export interface AccountEvent {
  event: AccountEventName;
  version: string;
  data: Record<string, unknown>;
}

const NAMES: ReadonlySet<string> = new Set(AccountEventNames);

/**
 * The contract's events in `logs`, in order. Other logs — other standards, plain text, malformed
 * JSON, unknown event names — are ignored, never thrown on.
 */
export function parseAccountEvents(logs: readonly string[]): AccountEvent[] {
  const out: AccountEvent[] = [];
  for (const line of logs) {
    if (!line.startsWith(PREFIX)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.slice(PREFIX.length));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const { standard, version, event, data } = parsed as Record<string, unknown>;
    if (standard !== EVENT_STANDARD || typeof event !== 'string' || !NAMES.has(event)) continue;
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    out.push({
      event: event as AccountEventName,
      version: typeof version === 'string' ? version : '',
      data: data as Record<string, unknown>,
    });
  }
  return out;
}

/** A `U64` JSON value (decimal string) as a bigint; null when absent or malformed. */
export function u64Of(v: unknown): bigint | null {
  if (typeof v === 'string' && /^\d{1,20}$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return null;
}

/** A block timestamp in nanoseconds (U64 JSON) as a Date (millisecond precision). */
export function nsToDate(v: unknown): Date | null {
  const ns = u64Of(v);
  return ns === null ? null : new Date(Number(ns / 1_000_000n));
}

/** Builds an `EVENT_JSON:` log line, as the contract emits it (tests and fakes). */
export function eventLog(event: AccountEventName, data: Record<string, unknown>): string {
  return `${PREFIX}${JSON.stringify({ standard: EVENT_STANDARD, version: '1.0.0', event, data })}`;
}
