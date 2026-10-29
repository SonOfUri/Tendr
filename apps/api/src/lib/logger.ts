import { env } from '../env.js';

// Field names are matched case-insensitively, so entries are stored lowercased.
const REDACT_KEYS = new Set(
  [
    'authorization',
    'apiKey',
    'api_key',
    'secret',
    'clientSecret',
    'client_secret',
    'signature',
    'walletSignature',
    'privateKey',
  ].map((k) => k.toLowerCase()),
);

/**
 * The secret-bearing parts of every configured RPC endpoint (any chain, any provider): path
 * segments and query values long enough to be a key, and URL credentials. Cached per env object.
 */
let rpcCache: { env: unknown; parts: string[] } | null = null;
function rpcSecretParts(): string[] {
  const e = env();
  if (rpcCache?.env === e) return rpcCache.parts;
  const urls = [
    ...Object.values(e.EVM_RPC_URLS ?? {}),
    e.SOLANA_RPC_URL,
    e.TRON_RPC_URL,
    e.NEAR_RPC_URL_LIVE,
    e.NEAR_RPC_URL_TEST,
  ];
  const parts = new Set<string>();
  for (const raw of urls) {
    let u: URL;
    try {
      u = new URL(String(raw));
    } catch {
      continue;
    }
    const candidates = [
      ...u.pathname.split('/').map(safeDecode),
      ...u.searchParams.values(),
      safeDecode(u.username),
      safeDecode(u.password),
    ];
    for (const c of candidates) {
      if (c.length < 12) continue;
      parts.add(c);
      parts.add(encodeURIComponent(c));
    }
  }
  // Longest first, so a key is never half-replaced by a shorter one.
  rpcCache = { env: e, parts: [...parts].sort((a, b) => b.length - a.length) };
  return rpcCache.parts;
}

/** decodeURIComponent that never throws: a malformed escape must not break logging. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const URL_RE = /\bhttps?:\/\/[^\s"'<>`]+/gi;
const KEY_PARAM = /^(?:key|apikey|api[-_]key|token|access[-_]token|auth|x-api-key)$/i;
/** A path segment that looks like a provider key (Alchemy, Infura, QuickNode, Ankr…). */
const KEY_SEGMENT = /^[A-Za-z0-9-]{20,}$/;

/**
 * Removes RPC provider keys from a string (final review m4): every configured RPC endpoint's
 * secret parts, and in any URL, key-like path segments, key-named query values and credentials.
 */
export function redactUrls(s: string): string {
  let out = s;
  for (const part of rpcSecretParts()) {
    if (out.includes(part)) out = out.split(part).join('[redacted]');
  }
  return out.replace(URL_RE, (raw) => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return raw;
    }
    let changed = false;
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
      changed = true;
    }
    const segs = u.pathname.split('/');
    const kept = segs.map((p) => (KEY_SEGMENT.test(p) ? '[redacted]' : p));
    if (kept.some((p, i) => p !== segs[i])) {
      u.pathname = kept.join('/');
      changed = true;
    }
    for (const k of [...u.searchParams.keys()]) {
      if (KEY_PARAM.test(k)) {
        u.searchParams.set(k, '[redacted]');
        changed = true;
      }
    }
    if (!changed) return raw;
    const redacted = u.toString();
    try {
      return decodeURI(redacted);
    } catch {
      return redacted;
    }
  });
}

function redact(value: unknown): unknown {
  if (typeof value === 'string') return redactUrls(value);
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
    msg: redactUrls(message),
    time: new Date().toISOString(),
    ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
  };

  console.log(JSON.stringify(line));
}
