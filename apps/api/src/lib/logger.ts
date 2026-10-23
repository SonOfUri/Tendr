import { env } from '../env.js';

const REDACT_KEYS = new Set([
  'authorization',
  'apiKey',
  'api_key',
  'secret',
  'signature',
  'walletSignature',
  'privateKey',
]);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redact(v);
    }
    return out;
  }
  return value;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function log(level: Level, message: string, fields?: Record<string, unknown>) {
  const min = env().LOG_LEVEL;
  if (order[level] < order[min]) return;
  const line = {
    level,
    msg: message,
    time: new Date().toISOString(),
    ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(line));
}
