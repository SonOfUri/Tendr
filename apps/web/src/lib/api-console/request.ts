export type ConsoleAuth = 'session' | 'bearer' | 'public';
export interface ConsoleRequest {
  method: string;
  path: string;
  query: string;
  auth: ConsoleAuth;
  bearer: string;
  merchantId: string;
  livemode: boolean;
  storeHeaders: boolean;
  csrf: string | null;
  headers: string;
  body: string;
  file?: File;
  assetKind?: string;
  multipart: boolean;
  signingSecret: string;
}

export function pathParameters(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z][A-Za-z0-9_]*)|\*/g)].map((m) => m[1] ?? '*');
}

export function fillPath(path: string, params: Record<string, string>): string {
  return path.replace(/:([A-Za-z][A-Za-z0-9_]*)|\*/g, (_, name: string | undefined) => {
    const key = name ?? '*';
    const v = params[key]?.trim();
    if (!v) throw new Error(`Enter the ${key === '*' ? 'asset path' : key} path parameter.`);
    return key === '*' ? v.split('/').map(encodeURIComponent).join('/') : encodeURIComponent(v);
  });
}

export function requestUrl(base: string, path: string, query: string): string {
  if (!path.startsWith('/v1/') || /[\\#\s]/.test(path))
    throw new Error('Use a relative /v1/ API path without a fragment.');
  const origin = new URL(base).origin;
  const url = new URL(path, origin);
  // URL normalisation must not escape the API prefix, including encoded dot segments.
  if (url.origin !== origin || !url.pathname.startsWith('/v1/'))
    throw new Error('The request must stay on the configured API.');
  for (const [key, v] of new URLSearchParams(query.replace(/^\?/, '')))
    url.searchParams.append(key, v);
  return url.href;
}

const CONTROLLED = new Set([
  'authorization',
  'cookie',
  'host',
  'origin',
  'tendr-csrf',
  'tendr-merchant',
  'tendr-livemode',
]);
export function extraHeaders(raw: string): Headers {
  const parsed: unknown = JSON.parse(raw.trim() || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Headers must be a JSON object of string values.');
  const headers = new Headers();
  for (const [key, v] of Object.entries(parsed)) {
    if (typeof v !== 'string') throw new Error(`Header ${key} must be a string.`);
    if (CONTROLLED.has(key.toLowerCase()))
      throw new Error(`Use the authentication and store controls for ${key}.`);
    headers.set(key, v);
  }
  return headers;
}

export async function requestSignature(
  secret: string,
  body: ArrayBuffer,
  timestamp = Math.floor(Date.now() / 1000),
): Promise<string> {
  const encoder = new TextEncoder();
  const prefix = encoder.encode(`${timestamp}.`);
  const bytes = new Uint8Array(prefix.length + body.byteLength);
  bytes.set(prefix);
  bytes.set(new Uint8Array(body), prefix.length);
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign('HMAC', key, bytes);
  const hex = Array.from(new Uint8Array(signed), (b) => b.toString(16).padStart(2, '0')).join('');
  return `t=${timestamp},v1=${hex}`;
}

export async function prepareRequest(
  base: string,
  input: ConsoleRequest,
): Promise<{ url: string; init: RequestInit }> {
  const url = requestUrl(base, input.path, input.query);
  const headers = extraHeaders(input.headers);
  headers.set('Accept', 'application/json');
  const writing = !['GET', 'HEAD', 'OPTIONS'].includes(input.method);
  if (input.auth === 'session') {
    if (writing && input.csrf) headers.set('Tendr-CSRF', input.csrf);
    if (input.storeHeaders) {
      if (!input.merchantId.trim()) throw new Error('Select a store or enter its merchant ID.');
      headers.set('Tendr-Merchant', input.merchantId.trim());
      headers.set('Tendr-Livemode', String(input.livemode));
    }
  }
  if (input.auth === 'bearer') {
    if (!input.bearer.trim()) throw new Error('Enter a bearer token.');
    headers.set('Authorization', `Bearer ${input.bearer.trim()}`);
  }
  let body: string | ArrayBuffer | undefined;
  if (writing && input.multipart) {
    if (!input.file) throw new Error('Choose a file to upload.');
    const form = new FormData();
    form.set('kind', input.assetKind ?? 'image');
    form.set('file', input.file);
    // Serialize once so HMAC signing covers the very same multipart bytes sent over the wire.
    const serialized = new Request(url, { method: 'POST', body: form });
    headers.set('Content-Type', serialized.headers.get('Content-Type')!);
    body = await serialized.arrayBuffer();
  } else if (writing && input.body.trim()) {
    JSON.parse(input.body); // Check syntax without reserializing numbers or changing signed bytes.
    headers.set('Content-Type', 'application/json');
    body = input.body;
  }
  if (input.signingSecret) {
    const bytes =
      typeof body === 'string'
        ? new TextEncoder().encode(body).buffer
        : (body ?? new ArrayBuffer(0));
    headers.set('Tendr-Signature', await requestSignature(input.signingSecret, bytes));
  }
  return {
    url,
    init: {
      method: input.method,
      headers,
      body,
      credentials: input.auth === 'session' ? 'include' : 'omit',
      cache: 'no-store',
      redirect: 'error',
    },
  };
}

/** Bound the inspector, including binary assets; never render server HTML as markup. */
export async function readResponse(
  response: Response,
  limit = 1_048_576,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limit - size;
      text += decoder.decode(value.subarray(0, remaining), { stream: true });
      size += value.byteLength;
      if (size > limit) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return { text, truncated };
}
